import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { chunkScorePages } from "../src/background/score-export-download.js";
import type { CapturedScoreSystem } from "../src/shared/capture-types.js";
import type { ScoreFingerprint } from "../src/shared/fingerprint-types.js";
import * as scoreIdentityConfig from "../src/shared/score-identity-config.js";
import { computeScorePagePlacements, packScorePages } from "../src/shared/score-page-layout.js";
import { ScorePageChunker } from "../src/offscreen/export/score-page-chunker.js";

const LEGACY_PAGE = {
  pageWidth: 1200,
  pageHeight: 1700,
  padding: 16,
  gap: 12
};

const CUSTOM_LAYOUT = {
  pageWidth: 600,
  pageHeight: 840,
  padding: 80,
  gap: 32
};

test("standalone PDF publishes one exact geometry and metadata policy", () => {
  // Given: the shared score identity module.
  const contract = Reflect.get(scoreIdentityConfig, "STANDALONE_SCORE_PDF");
  const metadata = Reflect.get(scoreIdentityConfig, "SCORE_PDF_METADATA");
  const metadataPolicy = Reflect.get(scoreIdentityConfig, "SCORE_PDF_METADATA_POLICY");

  // When: standalone PDF configuration is read.

  // Then: raster, MediaBox, layout, DPI, and privacy-minimal metadata are explicit.
  assert.deepEqual(contract, {
    rasterWidth: 1200,
    rasterHeight: 1700,
    pageWidth: 1200,
    pageHeight: 1700,
    padding: 16,
    gap: 12,
    targetDpi: 72
  });
  assert.deepEqual(metadata, {
    subject: "Score sheets extracted from user-supplied video",
    keywords: ["yt2sheet", "sheet music", "score export"],
    creator: "yt2sheet",
    producer: "yt2sheet 0.1.0"
  });
  assert.deepEqual(metadataPolicy, {
    titlePrefix: "yt2sheet score",
    author: "absent",
    sourceUrl: "absent",
    creationDate: "injected-created-at",
    modificationDate: "same-as-creation-date"
  });
});

test("shared layout uses an explicitly injected standalone layout", () => {
  // Given: a score whose page placement differs from the default geometry.
  const imageSizes = [{ width: 100, height: 50 }];
  const scores = [
    { image: { width: 1000, height: 720 } },
    { image: { width: 1000, height: 720 } }
  ];

  // When: placements receive a custom injected layout.
  const placements = Reflect.apply(computeScorePagePlacements, undefined, [imageSizes, CUSTOM_LAYOUT]);
  const pages = Reflect.apply(packScorePages, undefined, [scores, CUSTOM_LAYOUT]);

  // Then: the width fits the supplied MediaBox rather than the extension default.
  assert.ok(Math.abs((placements[0]?.width ?? 0) - (CUSTOM_LAYOUT.pageWidth - CUSTOM_LAYOUT.padding * 2)) < 0.000001);
  assert.equal(pages.length, 1);
});

test("extension active and offscreen paths retain legacy geometry and occurrence order", () => {
  // Given: non-consecutive occurrences in their reviewed order.
  const scores = [
    occurrence("A", "occ_A_1", 1),
    occurrence("B", "occ_B_1", 2),
    occurrence("A", "occ_A_2", 3),
    occurrence("C", "occ_C_1", 4)
  ];

  // When: both extension export paths use no explicit standalone layout.
  const activeScores = chunkScorePages(scores).flat();
  const offscreenPages = new ScorePageChunker().createPages("session_1", scores);
  const offscreenScores = offscreenPages.flatMap((page) => page.systems);

  // Then: extension output remains the legacy screen page and preserves A,B,A,C.
  assert.deepEqual(scoreIdentityConfig.SCORE_IDENTITY_CONFIG.page, LEGACY_PAGE);
  assert.deepEqual(activeScores.map((score) => score.clusterId), ["A", "B", "A", "C"]);
  assert.deepEqual(offscreenScores.map((score) => score.clusterId), ["A", "B", "A", "C"]);
  assert.deepEqual(offscreenPages.map((page) => ({ width: page.width, height: page.height })), [{ width: 1200, height: 1700 }]);
});

test("extension isolation fails against a temporary copied module with changed legacy geometry", () => {
  // Given: a copied compiled module tree with only the legacy extension page mutated.
  const tempRoot = mkdtempSync(join(tmpdir(), "yt2sheet-pdf-contract-"));

  try {
    const sourceRoot = join(process.cwd(), "build-test", "src");
    const copiedSourceRoot = join(tempRoot, "src");
    cpSync(sourceRoot, copiedSourceRoot, { recursive: true });
    symlinkSync(join(process.cwd(), "node_modules"), join(tempRoot, "node_modules"), "junction");
    const configPath = join(copiedSourceRoot, "shared", "score-identity-config.js");
    const mutatedConfig = readFileSync(configPath, "utf8")
      .replaceAll("pageWidth: 1200", "pageWidth: 2480")
      .replaceAll("pageHeight: 1700", "pageHeight: 3508")
      .replaceAll("padding: 16", "padding: 83")
      .replaceAll("gap: 12", "gap: 33");
    writeFileSync(configPath, mutatedConfig, "utf8");

    // When: the extension isolation assertion runs against that copied module variant.
    const result = spawnSync(process.execPath, ["-e", extensionIsolationProbe(copiedSourceRoot)], { encoding: "utf8" });

    // Then: it rejects the changed legacy geometry without touching the dirty source module.
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}${result.stdout}`, /extension legacy geometry changed/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

function occurrence(clusterId: string, occurrenceId: string, occurrenceOrder: number): CapturedScoreSystem {
  return {
    id: `captured_${occurrenceId}`,
    sessionId: "session_1",
    clusterId,
    source: {
      videoId: "video_12345",
      url: "https://www.youtube.com/watch?v=video_12345",
      firstSeenSec: occurrenceOrder,
      lastSeenSec: occurrenceOrder
    },
    image: {
      imageBlobId: `blob_${occurrenceId}`,
      dataUrl: "data:image/png;base64,AA==",
      width: 1600,
      height: 180
    },
    fingerprint: fingerprint(),
    qualityScore: 0.8,
    order: occurrenceOrder,
    occurrenceId,
    occurrenceOrder
  };
}

function fingerprint(): ScoreFingerprint {
  return {
    fullPHash: "0000000000000000",
    fullDHash: "0000000000000000",
    contentPHash: "0000000000000000",
    contentDHash: "0000000000000000",
    horizontalProjection: [0.2],
    verticalProjection: [0.2],
    aspectRatio: 1600 / 180,
    inkDensity: 0.18
  };
}

function extensionIsolationProbe(copiedSourceRoot: string): string {
  const configPath = join(copiedSourceRoot, "shared", "score-identity-config.js");
  const activePath = join(copiedSourceRoot, "background", "score-export-download.js");
  const offscreenPath = join(copiedSourceRoot, "offscreen", "export", "score-page-chunker.js");
  const scores = [
    occurrence("A", "occ_A_1", 1),
    occurrence("B", "occ_B_1", 2),
    occurrence("A", "occ_A_2", 3),
    occurrence("C", "occ_C_1", 4)
  ];

  return `
    const { SCORE_IDENTITY_CONFIG } = require(${JSON.stringify(configPath)});
    const { chunkScorePages } = require(${JSON.stringify(activePath)});
    const { ScorePageChunker } = require(${JSON.stringify(offscreenPath)});
    const scores = ${JSON.stringify(scores)};
    const active = chunkScorePages(scores).flat().map((score) => score.clusterId);
    const offscreen = new ScorePageChunker().createPages("session_1", scores);
    const ordered = ["A", "B", "A", "C"].join(",");
    if (
      SCORE_IDENTITY_CONFIG.page.pageWidth !== 1200 ||
      SCORE_IDENTITY_CONFIG.page.pageHeight !== 1700 ||
      active.join(",") !== ordered ||
      offscreen.flatMap((page) => page.systems).map((score) => score.clusterId).join(",") !== ordered
    ) {
      throw new Error("extension legacy geometry changed");
    }
  `;
}
