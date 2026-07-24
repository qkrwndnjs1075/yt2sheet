import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import sharp from "sharp";
import { hammingDistance } from "../server/score-analysis";
import { createDominantInkHash, normalizeScoreImage } from "../server/score-image-normalizer";
import { createScorePdfFromFrames, roundCrop } from "../server/score-video-processor";

describe("score video processor", () => {
  it("turns detected frames into a non-empty PDF and removes exact duplicates", async (t) => {
    const directory = await createTempDirectory(t, "yt2sheet-media-");
    const first = join(directory, "frame-1.png");
    const duplicate = join(directory, "frame-2.png");
    const changed = join(directory, "frame-3.png");
    await Promise.all([
      writeScoreFrame(first, 150),
      writeScoreFrame(duplicate, 150),
      writeScoreFrame(changed, 650)
    ]);
    const output = join(directory, "result.pdf");

    const result = await createScorePdfFromFrames([first, duplicate, changed], directory, output, pdfOptions());
    const pdf = await readFile(output);

    assert.equal(result.scoreCount, 2);
    assert.equal(result.pageCount, 1);
    assert.equal(pdf.subarray(0, 5).toString("ascii"), "%PDF-");
    assert.ok(pdf.length > 1_000);
  });

  it("keeps the original high-resolution score crop for PDF composition", async (t) => {
    const directory = await createTempDirectory(t, "yt2sheet-quality-");
    const lowResolution = join(directory, "source-960.png");
    const highResolution = join(directory, "frame-1920.png");
    await writeScoreFrame(lowResolution, 150);
    await sharp(lowResolution).resize(1920, 720).png().toFile(highResolution);

    await createScorePdfFromFrames([highResolution], directory, join(directory, "result.pdf"), pdfOptions());
    const scoreNames = await readdir(join(directory, "scores"));
    const scoreMetadata = await sharp(join(directory, "scores", scoreNames[0])).metadata();

    assert.equal(scoreMetadata.width, 1920);
    assert.ok((scoreMetadata.height ?? 0) > 300);
  });

  it("normalizes neutral gray score paper to white without erasing notation", async (t) => {
    const directory = await createTempDirectory(t, "yt2sheet-paper-");
    const frame = join(directory, "gray-paper.png");
    await writeScoreFrame(frame, 150, "rgb(222, 222, 222)");

    await createScorePdfFromFrames([frame], directory, join(directory, "result.pdf"), pdfOptions());
    const scoreNames = await readdir(join(directory, "scores"));
    const { data, info } = await sharp(join(directory, "scores", scoreNames[0])).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const background = 10 * info.channels + 10 * info.width * info.channels;
    let darkPixels = 0;
    for (let index = 0; index < data.length; index += info.channels) {
      if (data[index] < 50) darkPixels += 1;
    }

    assert.deepEqual([...data.subarray(background, background + 3)], [255, 255, 255]);
    assert.ok(darkPixels > 1_000, "staff notation was erased during paper normalization");
  });

  it("removes a connected photographic logo without erasing colored notation", async (t) => {
    const directory = await createTempDirectory(t, "yt2sheet-photo-");
    const frame = join(directory, "frame.png");
    await writeScoreFrameWithPhoto(frame);

    const direct = await normalizeScoreImage(await readFile(frame));
    const directPixels = await sharp(direct).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const blueHead = (120 * directPixels.info.width + 170) * directPixels.info.channels;
    const blueStem = (90 * directPixels.info.width + 182) * directPixels.info.channels;
    const removedPhoto = (72 * directPixels.info.width + 820) * directPixels.info.channels;

    assert.deepEqual([...directPixels.data.subarray(blueHead, blueHead + 3)], [30, 80, 210]);
    assert.deepEqual([...directPixels.data.subarray(blueStem, blueStem + 3)], [30, 80, 210]);
    assert.deepEqual([...directPixels.data.subarray(removedPhoto, removedPhoto + 3)], [255, 255, 255]);

    await createScorePdfFromFrames([frame], directory, join(directory, "result.pdf"), pdfOptions());
    const scoreNames = await readdir(join(directory, "scores"));
    const { data, info } = await sharp(join(directory, "scores", scoreNames[0])).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let titleDarkPixels = 0;
    let photoResiduePixels = 0;
    let blueNotationPixels = 0;
    for (let y = 0; y < 80; y += 1) {
      for (let x = 300; x < 520; x += 1) {
        if (data[(y * info.width + x) * info.channels] < 100) titleDarkPixels += 1;
      }
    }
    for (let y = 0; y <= 130; y += 1) {
      for (let x = 768; x <= 872; x += 1) {
        const offset = (y * info.width + x) * info.channels;
        if (data[offset] < 255 || data[offset + 1] < 255 || data[offset + 2] < 255) photoResiduePixels += 1;
      }
    }
    for (let index = 0; index < data.length; index += info.channels) {
      if (data[index + 2] > data[index] + 80) blueNotationPixels += 1;
    }

    assert.equal(photoResiduePixels, 0, "the photograph halo remained after normalization");
    assert.ok(blueNotationPixels > 100, "small colored notation was removed with the photograph");
    assert.ok(titleDarkPixels > 100, "score title was removed with the photograph");
  });

  it("deduplicates the same staff notation despite different outer padding", async (t) => {
    const directory = await createTempDirectory(t, "yt2sheet-staff-identity-");
    const first = join(directory, "frame-1.png");
    const second = join(directory, "frame-2.png");
    await Promise.all([
      writeScoreFrameWithPadding(first, 24, true),
      writeScoreFrameWithPadding(second, 72, false)
    ]);

    const result = await createScorePdfFromFrames([first, second], directory, join(directory, "result.pdf"), pdfOptions());

    assert.equal(result.scoreCount, 1);
  });

  it("removes a wide colored keyboard below the score", async (t) => {
    // Given: a paper-bright keyboard band that spans almost the full frame width.
    const directory = await createTempDirectory(t, "yt2sheet-keyboard-");
    const frame = join(directory, "frame.png");
    await writeScoreFrameWithKeyboard(frame);

    // When: the frame is converted to an extracted score.
    await createScorePdfFromFrames([frame], directory, join(directory, "result.pdf"), pdfOptions());
    const [scoreName] = await readdir(join(directory, "scores"));
    const { data, info } = await sharp(join(directory, "scores", scoreName)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let coloredPixels = 0;
    for (let index = 0; index < data.length; index += info.channels) {
      const red = data[index];
      const green = data[index + 1];
      const blue = data[index + 2];
      if (Math.max(red, green, blue) - Math.min(red, green, blue) > 12) coloredPixels += 1;
    }

    // Then: none of the colored keyboard surface remains in the score image.
    assert.equal(coloredPixels, 0);
  });

  it("normalizes equivalent notation to the same fixed outer padding", async () => {
    // Given: identical notation with different blank space above and below it.
    const first = await scoreStripBuffer(20, 120);
    const second = await scoreStripBuffer(70, 220);

    // When: both images are normalized with one fixed staff-relative padding.
    const [firstNormalized, secondNormalized] = await Promise.all([
      normalizeScoreImage(first, 12),
      normalizeScoreImage(second, 12)
    ]);
    const [firstMetadata, secondMetadata] = await Promise.all([
      sharp(firstNormalized).metadata(),
      sharp(secondNormalized).metadata()
    ]);

    // Then: outer source whitespace no longer changes the exported strip height.
    assert.equal(firstMetadata.height, secondMetadata.height);
    assert.equal(firstMetadata.height, 67);
  });

  it("builds the same dominant notation hash when a disconnected title is added", async (t) => {
    const directory = await createTempDirectory(t, "yt2sheet-dominant-ink-");
    const titled = join(directory, "titled.png");
    const plain = join(directory, "plain.png");
    const changed = join(directory, "changed.png");
    await Promise.all([
      writeScoreFrameWithPadding(titled, 24, true),
      writeScoreFrameWithPadding(plain, 24, false),
      writeScoreFrame(changed, 650)
    ]);

    const [titledHash, plainHash, changedHash] = await Promise.all([
      createDominantInkHash(await readFile(titled)),
      createDominantInkHash(await readFile(plain)),
      createDominantInkHash(await readFile(changed))
    ]);

    assert.ok(hammingDistance(titledHash, plainHash) <= 3);
    assert.ok(hammingDistance(plainHash, changedHash) > 8);
  });

  it("does not round a fractional paper boundary into the next source row", () => {
    const crop = roundCrop({ x: 0, y: 0, width: 1920, height: 604.5 }, 1920, 1080);

    assert.deepEqual(crop, { left: 0, top: 0, width: 1920, height: 604 });
  });

  it("observes cancellation after the PDF file is written", async (t) => {
    // Given: one valid frame and a signal cancelled by the final write progress event.
    const directory = await createTempDirectory(t, "yt2sheet-pdf-write-abort-");
    const frame = join(directory, "frame.png");
    const output = join(directory, "result.pdf");
    const controller = new AbortController();
    await writeScoreFrame(frame, 150);

    // When: PDF generation reaches the completed write boundary.
    const result = createScorePdfFromFrames([frame], directory, output, {
      ...pdfOptions(),
      signal: controller.signal,
      onProgress(progress: number) {
        if (progress === 98) controller.abort();
      }
    });

    // Then: the caller receives AbortError even though the owned output has been written.
    await assert.rejects(result, { name: "AbortError" });
    assert.equal((await readFile(output)).subarray(0, 5).toString("ascii"), "%PDF-");
  });
});

function pdfOptions() { return { metadata: { videoId: "test-video", createdAt: new Date("2026-07-24T00:00:00.000Z") } }; }

async function createTempDirectory(t: TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); t.diagnostic(JSON.stringify({ directory, tempRemoved: true })); });
  return directory;
}

async function writeScoreFrame(path: string, markerX: number, paper = "white"): Promise<void> {
  const lines = [90, 102, 114, 126, 138, 210, 222, 234, 246, 258]
    .map((y) => `<line x1="40" y1="${y}" x2="920" y2="${y}" stroke="black" stroke-width="2"/>`)
    .join("");
  const svg = Buffer.from(`<svg width="960" height="360" xmlns="http://www.w3.org/2000/svg">
    <rect width="960" height="360" fill="${paper}"/>
    ${lines}
    <ellipse cx="${markerX}" cy="120" rx="22" ry="14" fill="black"/>
    <line x1="${markerX + 20}" y1="120" x2="${markerX + 20}" y2="72" stroke="black" stroke-width="5"/>
    <ellipse cx="${markerX + 70}" cy="238" rx="22" ry="14" fill="black"/>
    <line x1="${markerX + 90}" y1="238" x2="${markerX + 90}" y2="190" stroke="black" stroke-width="5"/>
  </svg>`);
  await sharp(svg).png().toFile(path);
}

async function writeScoreFrameWithPhoto(path: string): Promise<void> {
  const lines = [150, 162, 174, 186, 198, 250, 262, 274, 286, 298]
    .map((y) => `<line x1="40" y1="${y}" x2="920" y2="${y}" stroke="black" stroke-width="2"/>`)
    .join("");
  const svg = Buffer.from(`<svg width="960" height="400" xmlns="http://www.w3.org/2000/svg">
    <rect width="960" height="400" fill="white"/>
    <text x="300" y="52" font-size="38">Waltz for Debby</text>
    <circle cx="820" cy="72" r="48" fill="rgb(200, 200, 200)"/>
    <circle cx="820" cy="72" r="44" fill="white"/>
    <circle cx="820" cy="72" r="40" fill="black"/>
    <ellipse cx="820" cy="72" rx="28" ry="14" fill="rgb(205, 120, 85)"/>
    ${lines}
    <ellipse cx="170" cy="120" rx="13" ry="9" fill="rgb(30, 80, 210)"/>
    <line x1="182" y1="120" x2="182" y2="86" stroke="rgb(30, 80, 210)" stroke-width="4"/>
  </svg>`);
  await sharp(svg).png().toFile(path);
}

async function writeScoreFrameWithPadding(path: string, top: number, includeHeader: boolean): Promise<void> {
  const staffLines = [top + 90, top + 102, top + 114, top + 126, top + 138, top + 210, top + 222, top + 234, top + 246, top + 258]
    .map((y) => `<line x1="40" y1="${y}" x2="920" y2="${y}" stroke="black" stroke-width="2"/>`)
    .join("");
  const header = includeHeader ? `<text x="300" y="48" font-size="34">Score title</text>` : "";
  const svg = Buffer.from(`<svg width="960" height="440" xmlns="http://www.w3.org/2000/svg">
    <rect width="960" height="440" fill="white"/>
    ${header}
    ${staffLines}
    <ellipse cx="220" cy="${top + 120}" rx="22" ry="14" fill="black"/>
    <line x1="240" y1="${top + 120}" x2="240" y2="${top + 72}" stroke="black" stroke-width="5"/>
    <ellipse cx="610" cy="${top + 238}" rx="22" ry="14" fill="black"/>
    <line x1="630" y1="${top + 238}" x2="630" y2="${top + 190}" stroke="black" stroke-width="5"/>
  </svg>`);
  await sharp(svg).png().toFile(path);
}

async function writeScoreFrameWithKeyboard(path: string): Promise<void> {
  const lines = [90, 102, 114, 126, 138, 210, 222, 234, 246, 258]
    .map((y) => `<line x1="40" y1="${y}" x2="920" y2="${y}" stroke="black" stroke-width="2"/>`)
    .join("");
  const dividers = Array.from({ length: 23 }, (_, index) => 48 + index * 39)
    .map((x) => `<line x1="${x}" y1="280" x2="${x}" y2="500" stroke="black" stroke-width="3"/>`)
    .join("");
  const svg = Buffer.from(`<svg width="960" height="520" xmlns="http://www.w3.org/2000/svg">
    <rect width="960" height="520" fill="white"/>
    ${lines}
    <ellipse cx="220" cy="120" rx="22" ry="14" fill="black"/>
    <line x1="240" y1="120" x2="240" y2="72" stroke="black" stroke-width="5"/>
    <rect x="40" y="280" width="880" height="220" fill="rgb(235, 215, 205)"/>
    <line x1="40" y1="280" x2="920" y2="280" stroke="black" stroke-width="4"/>
    ${dividers}
  </svg>`);
  await sharp(svg).png().toFile(path);
}

async function scoreStripBuffer(top: number, height: number): Promise<Buffer> {
  const svg = Buffer.from(`<svg width="240" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="240" height="${height}" fill="white"/>
    <rect x="20" y="${top}" width="200" height="3" fill="black"/>
    <rect x="80" y="${top + 3}" width="4" height="40" fill="black"/>
  </svg>`);
  return sharp(svg).png().toBuffer();
}
