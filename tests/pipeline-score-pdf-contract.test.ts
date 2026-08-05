import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { PDFDocument, type PDFPage } from "pdf-lib";
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFStream, decodePDFRawStream } from "pdf-lib/cjs/core";
import sharp from "sharp";
import packageMetadata from "../package.json";
import { STANDALONE_SCORE_PDF } from "../pipeline/score-identity-config.js";
import { computeScorePagePlacements } from "../pipeline/score-page-layout.js";
import { createScorePdfFromFrames } from "../pipeline/score-video-processor.js";

const CREATED_AT = new Date("2026-07-24T00:00:00.000Z");
const VIDEO_ID = "AbCdEfG1234";
const EXPECTED_PDF = {
  pageWidth: 595.2755905511812,
  pageHeight: 841.8897637795276,
  rasterWidth: 1200,
  rasterHeight: 1697,
  targetDpi: 145.14
} as const;

test("standalone PDF renderer writes the established single layout with privacy-minimal metadata", async (t) => {
  // Given: one detected score and the single standalone PDF contract.
  const directory = await createTempDirectory(t, "yt2sheet-pdf-contract-");
  const framePath = join(directory, "frame.png");
  await writeScoreFrame(framePath);

  const outputPath = join(directory, "result.pdf");

    // When: the standalone processor renders the PDF.
    await createScorePdfFromFrames([framePath], directory, outputPath, {
      metadata: { videoId: VIDEO_ID, createdAt: CREATED_AT }
    });
    const document = await PDFDocument.load(await readFile(outputPath), { updateMetadata: false });
    const page = document.getPage(0);
    const image = embeddedPageImage(page);

    // Then: the full raster is drawn over the physical page and the document has only the prescribed metadata.
    assert.equal(document.getPageCount(), 1);
    assertClose(page.getWidth(), EXPECTED_PDF.pageWidth, 0.01);
    assertClose(page.getHeight(), EXPECTED_PDF.pageHeight, 0.01);
    assertPageBoxesUseOnlyMediaBox(page);
    assert.equal(image.width, EXPECTED_PDF.rasterWidth);
    assert.equal(image.height, EXPECTED_PDF.rasterHeight);
    assert.match(pageContent(page), new RegExp(`${numberPattern(EXPECTED_PDF.pageWidth)} 0 0 ${numberPattern(EXPECTED_PDF.pageHeight)} 0 0 cm`));
    assertClose(image.width / (page.getWidth() / 72), EXPECTED_PDF.targetDpi, 0.05);
    assertClose(image.height / (page.getHeight() / 72), EXPECTED_PDF.targetDpi, 0.05);
    assert.equal(document.getTitle(), `yt2sheet score - ${VIDEO_ID}`);
    assert.equal(document.getSubject(), "Score sheets extracted from user-supplied video");
    assert.equal(document.getKeywords(), "yt2sheet sheet music score export");
    assert.equal(document.getCreator(), "yt2sheet");
    assert.equal(document.getProducer(), `${packageMetadata.name} ${packageMetadata.version}`);
    assert.equal(document.getAuthor(), undefined);
    assert.equal(document.getCreationDate()?.toISOString(), CREATED_AT.toISOString());
    assert.equal(document.getModificationDate()?.toISOString(), CREATED_AT.toISOString());
});

test("A4 raster contract keeps physical dimensions, margins, and aspect-preserving placements separate", () => {
  // Given: the fixed one-PDF score contract and two differently-shaped score rasters.
  const contract = STANDALONE_SCORE_PDF;
  const placements = computeScorePagePlacements([
    { width: 1000, height: 250 },
    { width: 1000, height: 500 }
  ]);
  const [wide, tall] = placements;

  // When: the raster page layout calculates their printable placements.

  // Then: ISO A4 points stay distinct from raster pixels, with exact physical margins and gaps.
  assert.equal(contract.pdfPageWidthPoints, EXPECTED_PDF.pageWidth);
  assert.equal(contract.pdfPageHeightPoints, EXPECTED_PDF.pageHeight);
  assert.equal(contract.rasterWidth, EXPECTED_PDF.rasterWidth);
  assert.equal(contract.rasterHeight, EXPECTED_PDF.rasterHeight);
  assert.equal(contract.contentMarginMillimetres, 10);
  assert.equal(contract.contentMarginPixels, 57);
  assert.equal(contract.interSheetGapMillimetres, 4);
  assert.equal(contract.interSheetGapPixels, 23);
  assert.ok(wide && tall, "both score placements are required");
  assertClose(wide.x, 57);
  assertClose(wide.y, 57);
  assertClose(wide.width / wide.height, 4);
  assertClose(tall.width / tall.height, 2);
  assertClose(tall.y - (wide.y + wide.height), 23);
  for (const placement of placements) {
    assert.ok(placement.x >= 57 && placement.y >= 57, "placement must stay inside the content margin");
    assert.ok(placement.x + placement.width <= 1143, "placement must not overflow the raster page width");
    assert.ok(placement.y + placement.height <= 1640, "placement must not overflow the raster page height");
  }
});

function embeddedPageImage(page: PDFPage): { readonly width: number; readonly height: number } {
  const resources = page.node.Resources();
  assert.ok(resources, "PDF page resources are required");
  const xObjects = resources.lookupMaybe(PDFName.of("XObject"), PDFDict);
  assert.ok(xObjects, "PDF page must contain an image XObject");
  const images = xObjects.keys().flatMap((name) => {
    const image = xObjects.lookupMaybe(name, PDFStream);
    return image instanceof PDFRawStream ? [image] : [];
  });
  assert.equal(images.length, 1);
  const image = images[0];
  assert.ok(image, "PDF page image is required");
  const width = image.dict.lookupMaybe(PDFName.of("Width"), PDFNumber);
  const height = image.dict.lookupMaybe(PDFName.of("Height"), PDFNumber);
  assert.ok(width, "PDF image width is required");
  assert.ok(height, "PDF image height is required");
  return { width: width.asNumber(), height: height.asNumber() };
}

function assertPageBoxesUseOnlyMediaBox(page: PDFPage): void {
  const mediaBox = page.node.get(PDFName.of("MediaBox"));
  assert.ok(mediaBox, "PDF page MediaBox is required");
  for (const name of ["CropBox", "TrimBox", "BleedBox", "ArtBox"]) {
    assert.equal(page.node.get(PDFName.of(name)), undefined, `${name} must be absent so it defaults to MediaBox`);
  }
}

function pageContent(page: PDFPage): string {
  const contents = page.node.Contents();
  assert.ok(contents, "PDF page content stream is required");
  if (contents instanceof PDFRawStream) {
    return Buffer.from(decodePDFRawStream(contents).decode()).toString("ascii");
  }
  assert.ok(contents instanceof PDFArray, "PDF content must be one stream or an array of streams");
  return Array.from({ length: contents.size() }, (_, index) => {
    const stream = contents.lookupMaybe(index, PDFRawStream);
    assert.ok(stream, "PDF content array must contain raw streams");
    return Buffer.from(decodePDFRawStream(stream).decode()).toString("ascii");
  }).join("\n");
}

function numberPattern(value: number): string {
  return value.toString().replace(".", "\\.");
}

function assertClose(actual: number, expected: number, tolerance = 0.000001): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);
}

async function createTempDirectory(t: TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    t.diagnostic(JSON.stringify({ directory, tempRemoved: true }));
  });
  return directory;
}

async function writeScoreFrame(path: string, markerOffset = 0): Promise<void> {
  const lines = [90, 102, 114, 126, 138, 210, 222, 234, 246, 258]
    .map((y) => `<line x1="40" y1="${y}" x2="920" y2="${y}" stroke="black" stroke-width="2"/>`)
    .join("");
  const svg = Buffer.from(`<svg width="960" height="360" xmlns="http://www.w3.org/2000/svg">
    <rect width="960" height="360" fill="white"/>
    ${lines}
    <ellipse cx="${220 + markerOffset}" cy="120" rx="22" ry="14" fill="black"/>
    <line x1="${240 + markerOffset}" y1="120" x2="${240 + markerOffset}" y2="72" stroke="black" stroke-width="5"/>
    <ellipse cx="${610 - markerOffset}" cy="238" rx="22" ry="14" fill="black"/>
    <line x1="${630 - markerOffset}" y1="238" x2="${630 - markerOffset}" y2="190" stroke="black" stroke-width="5"/>
  </svg>`);
  await sharp(svg).png().toFile(path);
}
