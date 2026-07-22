import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import sharp from "sharp";
import { hammingDistance } from "../server/score-analysis";
import { createDominantInkHash } from "../server/score-image-normalizer";
import { createScorePdfFromFrames, roundCrop } from "../server/score-video-processor";

describe("score video processor", () => {
  it("turns detected frames into a non-empty PDF and removes exact duplicates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yt2sheet-media-"));
    const first = join(directory, "frame-1.png");
    const duplicate = join(directory, "frame-2.png");
    const changed = join(directory, "frame-3.png");
    await Promise.all([
      writeScoreFrame(first, 150),
      writeScoreFrame(duplicate, 150),
      writeScoreFrame(changed, 650)
    ]);
    const output = join(directory, "result.pdf");

    const result = await createScorePdfFromFrames([first, duplicate, changed], directory, output);
    const pdf = await readFile(output);

    assert.equal(result.scoreCount, 2);
    assert.equal(result.pageCount, 1);
    assert.equal(pdf.subarray(0, 5).toString("ascii"), "%PDF-");
    assert.ok(pdf.length > 1_000);
  });

  it("keeps the original high-resolution score crop for PDF composition", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yt2sheet-quality-"));
    const lowResolution = join(directory, "source-960.png");
    const highResolution = join(directory, "frame-1920.png");
    await writeScoreFrame(lowResolution, 150);
    await sharp(lowResolution).resize(1920, 720).png().toFile(highResolution);

    await createScorePdfFromFrames([highResolution], directory, join(directory, "result.pdf"));
    const scoreNames = await readdir(join(directory, "scores"));
    const scoreMetadata = await sharp(join(directory, "scores", scoreNames[0])).metadata();

    assert.equal(scoreMetadata.width, 1920);
    assert.ok((scoreMetadata.height ?? 0) > 300);
  });

  it("normalizes neutral gray score paper to white without erasing notation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yt2sheet-paper-"));
    const frame = join(directory, "gray-paper.png");
    await writeScoreFrame(frame, 150, "rgb(222, 222, 222)");

    await createScorePdfFromFrames([frame], directory, join(directory, "result.pdf"));
    const scoreNames = await readdir(join(directory, "scores"));
    const { data, info } = await sharp(join(directory, "scores", scoreNames[0])).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const background = 10 * info.channels + 10 * info.width * info.channels;
    const notation = 90 * info.width * info.channels + 100 * info.channels;

    assert.deepEqual([...data.subarray(background, background + 3)], [255, 255, 255]);
    assert.ok(data[notation] < 50, "staff notation was erased during paper normalization");
  });

  it("removes a connected photographic logo without erasing colored notation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yt2sheet-photo-"));
    const frame = join(directory, "frame.png");
    await writeScoreFrameWithPhoto(frame);

    await createScorePdfFromFrames([frame], directory, join(directory, "result.pdf"));
    const scoreNames = await readdir(join(directory, "scores"));
    const { data, info } = await sharp(join(directory, "scores", scoreNames[0])).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const photo = 72 * info.width * info.channels + 820 * info.channels;
    const coloredNotation = 120 * info.width * info.channels + 170 * info.channels;
    let titleDarkPixels = 0;
    let photoResiduePixels = 0;
    for (let y = 20; y < 60; y += 1) {
      for (let x = 300; x < 520; x += 1) {
        if (data[(y * info.width + x) * info.channels] < 100) titleDarkPixels += 1;
      }
    }
    for (let y = 22; y <= 122; y += 1) {
      for (let x = 768; x <= 872; x += 1) {
        const offset = (y * info.width + x) * info.channels;
        if (data[offset] < 255 || data[offset + 1] < 255 || data[offset + 2] < 255) photoResiduePixels += 1;
      }
    }

    assert.deepEqual([...data.subarray(photo, photo + 3)], [255, 255, 255]);
    assert.equal(photoResiduePixels, 0, "the photograph halo remained after normalization");
    assert.ok(data[coloredNotation + 2] > data[coloredNotation], "small colored notation was removed with the photograph");
    assert.ok(titleDarkPixels > 100, "score title was removed with the photograph");
  });

  it("deduplicates the same staff notation despite different outer padding", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yt2sheet-staff-identity-"));
    const first = join(directory, "frame-1.png");
    const second = join(directory, "frame-2.png");
    await Promise.all([
      writeScoreFrameWithPadding(first, 24, true),
      writeScoreFrameWithPadding(second, 72, false)
    ]);

    const result = await createScorePdfFromFrames([first, second], directory, join(directory, "result.pdf"));

    assert.equal(result.scoreCount, 1);
  });

  it("builds the same dominant notation hash when a disconnected title is added", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yt2sheet-dominant-ink-"));
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
});

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
