import assert from "node:assert/strict";
import { test } from "node:test";
import { PDFDocument } from "pdf-lib";
import { chunkScorePages, exportApprovedPreviewAsPdf, exportScoresAsPdf, previewPageBlobs, safeFileBaseName } from "../src/background/score-export-download.js";
import { computeScorePagePlacements } from "../src/shared/score-page-layout.js";
import { SCORE_IDENTITY_CONFIG } from "../src/shared/score-identity-config.js";
import type { DebugUniqueScore } from "../src/shared/messages.js";

const ONE_BY_ONE_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x04, 0x00, 0x00, 0x00, 0xb5, 0x1c, 0x0c,
  0x02, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xfa, 0xcf, 0x00, 0x00,
  0x02, 0x07, 0x01, 0x02, 0x9a, 0x1c, 0x31, 0x71, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82
]);

const IMAGE_DATA_URL = `data:image/png;base64,${Buffer.from(ONE_BY_ONE_PNG).toString("base64")}`;

test("download export chunker uses remaining page height beyond five compact scores", () => {
  // Given: six compact scores whose width-fitted heights all fit on one page.
  const scores = [
    score("A", 3, 1),
    score("B", 1, 2),
    score("A", 2, 3),
    score("C", 4, 4),
    score("D", 5, 5),
    score("E", 6, 6),
    score("F", 7, 7),
    score("missing", 8, 8, "")
  ];

  // When: the reviewed scores are divided into export pages.
  const pages = chunkScorePages(scores);

  // Then: the sixth score uses the remaining first-page space instead of forcing a blank-heavy second page.
  assert.deepEqual(
    pages.map((page) => page.map((system) => system.clusterId)),
    [["B", "A", "C", "D", "E", "F"]]
  );
});

test("download export chunker starts a new page when the next compact score exceeds the remaining height", () => {
  // Given: twelve compact scores, while exactly eleven fit within the printable page height.
  const scores = "ABCDEFGHIJKL".split("").map((clusterId, index) => score(clusterId, index, index));

  // When: the scores are divided into export pages.
  const pages = chunkScorePages(scores);

  // Then: the first page is filled to capacity and the overflowing score starts page two.
  assert.deepEqual(pages.map((page) => page.length), [11, 1]);
});

test("download export chunker keeps non-consecutive score occurrences as separate pages entries", () => {
  const scores = [
    occurrenceScore("A", "occ_A_1", 1),
    occurrenceScore("A", "occ_A_1", 2),
    occurrenceScore("A", "occ_A_1", 3),
    occurrenceScore("B", "occ_B_1", 4),
    occurrenceScore("A", "occ_A_2", 5),
    occurrenceScore("A", "occ_A_2", 6),
    occurrenceScore("C", "occ_C_1", 7)
  ];

  assert.deepEqual(
    chunkScorePages(scores).map((page) => page.map((system) => system.clusterId)),
    [["A", "B", "A", "C"]]
  );
});

test("download export chunker honors a user-reviewed cluster order", () => {
  const scores = [
    score("A", 3, 1),
    score("B", 1, 2),
    score("A", 2, 3),
    score("C", 4, 4),
    score("D", 5, 5)
  ];

  assert.deepEqual(
    chunkScorePages(scores, { scoreOrder: ["D", "A", "B"] }).map((page) => page.map((system) => system.clusterId)),
    [["D", "A", "B"]]
  );
});

test("download export chunker prefers occurrence order and preserves distinct repeated cluster occurrences", () => {
  const scores = [
    occurrenceScore("A", "occ_A_1", 1),
    occurrenceScore("B", "occ_B_1", 2),
    occurrenceScore("A", "occ_A_2", 3),
    occurrenceScore("C", "occ_C_1", 4)
  ];
  const systems = chunkScorePages(scores, { scoreOrder: [], occurrenceOrder: ["occ_A_2", "occ_A_1"] }).flat();

  assert.deepEqual(systems.map((system) => system.clusterId), ["A", "A"]);
  assert.deepEqual(systems.map((system) => system.occurrenceId), ["occ_A_2", "occ_A_1"]);
});

test("download export chunker ignores missing and duplicate reviewed cluster ids", () => {
  const scores = [
    score("A", 3, 1),
    score("B", 1, 2),
    score("C", 4, 4)
  ];

  assert.deepEqual(
    chunkScorePages(scores, { scoreOrder: ["missing", "B", "B", "A"] }).map((page) => page.map((system) => system.clusterId)),
    [["B", "A"]]
  );
});

test("download PDF exporter creates a PDF from unique score image data URLs", async () => {
  const pdf = await exportScoresAsPdf([score("A", 1, 1), score("A", 2, 2), score("B", 3, 3)]);

  assert.equal(pdf.type, "application/pdf");
  assert.equal(await pdf.slice(0, 5).text(), "%PDF-");
});

test("download PDF exporter uses dynamic page capacity for compact scores", async () => {
  // Given: twelve compact scores, with eleven fitting inside one printable page.
  const scores = "ABCDEFGHIJKL".split("").map((clusterId, index) => score(clusterId, index, index));

  // When: the active download path renders the scores into a PDF.
  const pdf = await exportScoresAsPdf(scores);
  const document = await PDFDocument.load(await pdf.arrayBuffer());

  // Then: the PDF contains one full page and one overflow page instead of fixed five-score pages.
  assert.equal(document.getPageCount(), 2);
});

test("approved preview pages are the exact PNG inputs used by final export", async () => {
  const pages = [
    { pageIndex: 0, dataUrl: IMAGE_DATA_URL },
    { pageIndex: 1, dataUrl: IMAGE_DATA_URL }
  ];
  const pngPages = previewPageBlobs(pages);
  const pdf = await exportApprovedPreviewAsPdf(pages);
  const document = await PDFDocument.load(await pdf.arrayBuffer());
  const firstPngPage = pngPages[0];

  assert.equal(pngPages.length, 2);
  assert.ok(firstPngPage);
  assert.deepEqual(new Uint8Array(await firstPngPage.arrayBuffer()), ONE_BY_ONE_PNG);
  assert.equal(document.getPageCount(), 2);
});

test("approved preview pages must be complete and sequential", () => {
  assert.throws(() => previewPageBlobs([]), /preview/i);
  assert.throws(() => previewPageBlobs([{ pageIndex: 1, dataUrl: IMAGE_DATA_URL }]), /preview/i);
  assert.throws(() => previewPageBlobs([{ pageIndex: 0, dataUrl: "data:image/jpeg;base64,AA==" }]), /PNG/i);
});

test("download filename sanitizer removes browser-invalid filename characters", () => {
  assert.equal(safeFileBaseName('A/B:C*D?E"F<G>H|I-score'), "A B C D E F G H I-score");
  assert.equal(safeFileBaseName("   "), "score-export");
});

test("score page layout keeps a fixed system gap and balances outer whitespace", () => {
  // Given: two compact scores that leave unused space after fitting to the printable width.
  const imageSizes = [
    { width: 1600, height: 180 },
    { width: 1600, height: 180 }
  ];

  // When: placements are computed for one PDF page.
  const placements = computeScorePagePlacements(imageSizes);

  // Then: unused height stays outside the score group and the configured gap remains fixed.
  const first = placements[0];
  const last = placements[placements.length - 1];
  const actualGap = placements[1].y - (placements[0].y + placements[0].height);
  const topWhitespace = first.y - SCORE_IDENTITY_CONFIG.page.padding;
  const bottomWhitespace = SCORE_IDENTITY_CONFIG.page.pageHeight
    - SCORE_IDENTITY_CONFIG.page.padding
    - (last.y + last.height);

  assert.ok(first);
  assert.ok(last);
  assert.equal(SCORE_IDENTITY_CONFIG.page.gap, 16);
  assert.equal(Math.round(actualGap), 16);
  assert.ok(Math.abs(topWhitespace - bottomWhitespace) < 1);
  assert.equal(first.width / first.height, 1600 / 180);
  assert.equal(last.width / last.height, 1600 / 180);
});

test("score page layout keeps an extremely tall score inside printable bounds", () => {
  // Given: one score whose width-fitted height is far taller than a page.
  const [placement] = computeScorePagePlacements([{ width: 100, height: 100_000 }]);

  // When: the placement is compressed to the printable page height.
  const bottom = (placement?.y ?? 0) + (placement?.height ?? 0);

  // Then: the score does not extend below the printable page boundary.
  assert.ok(bottom <= SCORE_IDENTITY_CONFIG.page.pageHeight - SCORE_IDENTITY_CONFIG.page.padding);
});

function score(clusterId: string, firstSeenSec: number, order: number, dataUrl = IMAGE_DATA_URL): DebugUniqueScore {
  return {
    id: `captured_${clusterId}_${order}`,
    sessionId: "session_1",
    clusterId,
    source: {
      videoId: "video_1",
      url: "https://www.youtube.com/watch?v=video_1",
      firstSeenSec,
      lastSeenSec: firstSeenSec
    },
    image: {
      imageBlobId: `blob_${clusterId}`,
      dataUrl,
      width: 1600,
      height: 180
    },
    qualityScore: 0.8,
    order
  };
}

function occurrenceScore(clusterId: string, occurrenceId: string, occurrenceOrder: number): DebugUniqueScore {
  const current = score(clusterId, occurrenceOrder, occurrenceOrder);
  return {
    ...current,
    id: `captured_${occurrenceId}_${occurrenceOrder}`,
    occurrenceId,
    occurrenceOrder
  };
}
