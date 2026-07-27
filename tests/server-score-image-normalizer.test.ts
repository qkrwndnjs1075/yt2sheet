import assert from "node:assert/strict";
import { describe, it } from "node:test";
import sharp from "sharp";
import { normalizeScoreImage } from "../server/score-image-normalizer";

describe("score image normalizer", () => {
  it("removes detached non-score text below the last staff context", async () => {
    // Given: a score whose bottom-right watermark is separated from all notation.
    const image = await scoreWithDetachedCaption();

    // When: the standalone server normalizes the score for PDF output.
    const normalized = await normalizeScoreImage(image);

    // Then: the detached caption region is pure paper white.
    assert.equal(await darkPixelsIn(normalized, { left: 680, top: 330, width: 260, height: 70 }), 0);
  });

  it("preserves musical text near staff while removing a remote caption", async () => {
    // Given: a tempo direction above a grand staff and an unrelated footer signature.
    const image = await scoreWithDetachedCaption();

    // When: the standalone server normalizes the score for PDF output.
    const normalized = await normalizeScoreImage(image);

    // Then: musical text and notation remain, while only the remote caption disappears.
    assert.ok(await darkPixelsIn(normalized, { left: 80, top: 55, width: 230, height: 50 }) > 100);
    assert.ok(await darkPixelsIn(normalized, { left: 40, top: 115, width: 880, height: 170 }) > 5_000);
    assert.equal(await darkPixelsIn(normalized, { left: 680, top: 330, width: 260, height: 70 }), 0);
  });

  it("removes a right watermark when lower notation continues elsewhere", async () => {
    // Given: a low note extends the global content rows while a separate watermark sits at the right.
    const image = await scoreWithDetachedCaption(true);

    // When: the standalone server normalizes the score for PDF output.
    const normalized = await normalizeScoreImage(image);

    // Then: the low note remains and cannot keep the unrelated right-side watermark alive.
    assert.ok(await darkPixelsIn(normalized, { left: 220, top: 275, width: 110, height: 75 }) > 100);
    assert.equal(await darkPixelsIn(normalized, { left: 680, top: 330, width: 260, height: 70 }), 0);
  });

  it("removes a full-height edge artifact while preserving internal notation", async () => {
    // Given: a score with a capture boundary attached to the left page edge.
    const image = await scoreWithFullHeightEdge();

    // When: the standalone server normalizes the score for PDF output.
    const normalized = await normalizeScoreImage(image);

    // Then: the edge becomes white while a staff line and internal barline remain foreground.
    assert.deepEqual(await rgbAt(normalized, 2, 200), [255, 255, 255]);
    assert.ok(Math.min(...(await rgbAt(normalized, 100, 120))) < 250);
    assert.ok(Math.min(...(await rgbAt(normalized, 480, 140))) < 250);
  });

  it("removes a short boundary fragment outside the score", async () => {
    // Given: a short capture remnant touches the right edge beyond the staff system.
    const image = await scoreWithShortEdgeFragment();

    // When: the standalone server normalizes the score for PDF output.
    const normalized = await normalizeScoreImage(image);

    // Then: the isolated edge fragment is white and the internal notation remains foreground.
    assert.deepEqual(await rgbAt(normalized, 959, 80), [255, 255, 255]);
    assert.ok(Math.min(...(await rgbAt(normalized, 100, 120))) < 250);
    assert.ok(Math.min(...(await rgbAt(normalized, 480, 140))) < 250);
  });

  it("removes a top-right publisher logo while preserving chord names and tempo marks", async () => {
    // Given: a grand staff with tempo/chord text plus an isolated publisher logo pinned to the top-right corner.
    const image = await scoreWithTopRightLogo();

    // When: the standalone server normalizes the score for PDF output.
    const normalized = await normalizeScoreImage(image);

    // Then: the corner logo is erased while tempo, left/center/right chord names, and the staff survive.
    assert.equal(await darkPixelsIn(normalized, { left: 865, top: 15, width: 95, height: 55 }), 0);
    assert.ok(await darkPixelsIn(normalized, { left: 80, top: 55, width: 230, height: 50 }) > 100);
    assert.ok(await darkPixelsIn(normalized, { left: 295, top: 78, width: 80, height: 30 }) > 10);
    assert.ok(await darkPixelsIn(normalized, { left: 755, top: 78, width: 80, height: 30 }) > 10);
    assert.ok(await darkPixelsIn(normalized, { left: 40, top: 115, width: 880, height: 150 }) > 5_000);
  });
});

async function scoreWithDetachedCaption(includeLowerTail = false): Promise<Buffer> {
  const staffLines = [120, 132, 144, 156, 168, 210, 222, 234, 246, 258]
    .map((y) => `<line x1="40" y1="${y}" x2="920" y2="${y}" stroke="black" stroke-width="2"/>`)
    .join("");
  const svg = Buffer.from(`<svg width="960" height="420" xmlns="http://www.w3.org/2000/svg">
    <rect width="960" height="420" fill="white"/>
    <text x="80" y="96" font-size="28">tempo rubato</text>
    ${staffLines}
    <ellipse cx="270" cy="276" rx="18" ry="11" fill="black"/>
    <line x1="288" y1="276" x2="288" y2="236" stroke="black" stroke-width="4"/>
    ${includeLowerTail ? '<ellipse cx="270" cy="330" rx="18" ry="11" fill="black"/><line x1="288" y1="330" x2="288" y2="278" stroke="black" stroke-width="4"/>' : ""}
    <text x="710" y="382" font-size="30" font-family="cursive">Pianoin U</text>
  </svg>`);
  return sharp(svg).png().toBuffer();
}

async function scoreWithFullHeightEdge(): Promise<Buffer> {
  const staffLines = [120, 132, 144, 156, 168]
    .map((y) => `<line x1="40" y1="${y}" x2="920" y2="${y}" stroke="black" stroke-width="2"/>`)
    .join("");
  const svg = Buffer.from(`<svg width="960" height="420" xmlns="http://www.w3.org/2000/svg">
    <rect width="960" height="420" fill="white"/>
    ${staffLines}
    <line x1="480" y1="120" x2="480" y2="168" stroke="black" stroke-width="4"/>
    <rect x="0" y="0" width="6" height="420" fill="black"/>
  </svg>`);
  return sharp(svg).png().toBuffer();
}

async function scoreWithShortEdgeFragment(): Promise<Buffer> {
  const staffLines = [120, 132, 144, 156, 168]
    .map((y) => `<line x1="40" y1="${y}" x2="920" y2="${y}" stroke="black" stroke-width="2"/>`)
    .join("");
  const svg = Buffer.from(`<svg width="960" height="420" xmlns="http://www.w3.org/2000/svg">
    <rect width="960" height="420" fill="white"/>
    ${staffLines}
    <line x1="480" y1="120" x2="480" y2="168" stroke="black" stroke-width="4"/>
    <rect x="959" y="76" width="1" height="9" fill="black"/>
  </svg>`);
  return sharp(svg).png().toBuffer();
}

async function scoreWithTopRightLogo(): Promise<Buffer> {
  const staffLines = [120, 132, 144, 156, 168, 210, 222, 234, 246, 258]
    .map((y) => `<line x1="40" y1="${y}" x2="920" y2="${y}" stroke="black" stroke-width="2"/>`)
    .join("");
  const svg = Buffer.from(`<svg width="960" height="420" xmlns="http://www.w3.org/2000/svg">
    <rect width="960" height="420" fill="white"/>
    <text x="80" y="96" font-size="28">tempo rubato</text>
    <text x="300" y="100" font-size="24">Cm9</text>
    <text x="760" y="100" font-size="24">Dm/F</text>
    ${staffLines}
    <text x="872" y="40" font-size="24" font-family="cursive">PianoinU</text>
    <text x="872" y="58" font-size="10">PREMIUM SCORE</text>
  </svg>`);
  return sharp(svg).png().toBuffer();
}

async function rgbAt(image: Buffer, x: number, y: number): Promise<readonly number[]> {
  const { data } = await sharp(image).extract({ left: x, top: y, width: 1, height: 1 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return [data[0], data[1], data[2]];
}

async function darkPixelsIn(
  image: Buffer,
  region: { readonly left: number; readonly top: number; readonly width: number; readonly height: number }
): Promise<number> {
  const { data, info } = await sharp(image).extract(region).greyscale().raw().toBuffer({ resolveWithObject: true });
  let count = 0;
  for (let index = 0; index < data.length; index += info.channels) {
    if (data[index] < 200) count += 1;
  }
  return count;
}
