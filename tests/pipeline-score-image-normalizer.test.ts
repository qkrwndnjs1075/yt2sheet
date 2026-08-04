import assert from "node:assert/strict";
import { describe, it } from "node:test";
import sharp from "sharp";
import {
  createScoreRepresentativeQuality,
  hasFadedNotationOverlap,
  hasStrongNotationOverlap,
  normalizeScoreImage,
  type NotationIdentity
} from "../pipeline/score-image-normalizer";

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

  it("preserves the complete composer name when its final letters enter the top-right corner", async () => {
    // Given: legitimate composer text begins inside the score and ends inside the old logo-removal zone.
    const image = await scoreWithRightAlignedComposerName();
    const trailingRegion = { left: 860, top: 55, width: 90, height: 50 };
    const sourceTrailingInk = await darkPixelsIn(image, trailingRegion);

    // When: the score is normalized for PDF output.
    const normalized = await normalizeScoreImage(image);

    // Then: every trailing letter remains instead of being mistaken for separate logo components.
    assert.ok(sourceTrailingInk > 20);
    assert.equal(await darkPixelsIn(normalized, trailingRegion), sourceTrailingInk);
  });

  it("measures neutral gray score paper against its own paper tone", async () => {
    const [clean, faded] = await Promise.all([
      scoreForRepresentativeQuality("white"),
      scoreForRepresentativeQuality("rgb(203, 203, 203)")
    ]);
    const fadedBefore = Buffer.from(faded);

    const [cleanQuality, fadedQuality] = await Promise.all([
      createScoreRepresentativeQuality(clean),
      createScoreRepresentativeQuality(faded)
    ]);

    assert.ok(Math.abs(cleanQuality.contentHeightRatio - fadedQuality.contentHeightRatio) < 0.001);
    assert.equal(cleanQuality.paperLuminance, 255);
    assert.equal(fadedQuality.paperLuminance, 203);
    assert.deepEqual(faded, fadedBefore, "quality measurement must not alter faded score pixels");
  });

  it("measures a delayed title as more complete score context while preserving low-contrast notation", async () => {
    const [plain, titled] = await Promise.all([
      scoreForRepresentativeQuality("white"),
      scoreForRepresentativeQuality("white", true)
    ]);
    const titledBefore = Buffer.from(titled);

    const [plainQuality, titledQuality] = await Promise.all([
      createScoreRepresentativeQuality(plain),
      createScoreRepresentativeQuality(titled)
    ]);

    assert.ok(titledQuality.contentHeightRatio >= plainQuality.contentHeightRatio * 1.04);
    assert.ok(titledQuality.inkContrast > 0, "low-contrast notation must still contribute to representative quality");
    assert.deepEqual(titled, titledBefore, "quality measurement must not erase notation");
  });

  it("recognizes a faded score identity without relaxing the normal duplicate threshold", () => {
    const [clean, faded] = fadedNotationIdentities();

    assert.equal(hasStrongNotationOverlap(clean, faded), false);
    assert.equal(hasFadedNotationOverlap(clean, faded, 255, 182), true);
    assert.equal(hasFadedNotationOverlap(clean, faded, 255, 255), false);
  });
});

function fadedNotationIdentities(): readonly [NotationIdentity, NotationIdentity] {
  const width = 96;
  const height = 48;
  const cleanPixels = new Uint8Array(width * height);
  const fadedPixels = new Uint8Array(width * height);
  cleanPixels.fill(1, 0, 1_358);
  fadedPixels.fill(1, 0, 1_092);
  fadedPixels.fill(1, 1_358, 2_026);
  return [
    { width, height, pixels: cleanPixels, staffGap: 13 },
    { width, height, pixels: fadedPixels, staffGap: 13 }
  ];
}

async function scoreForRepresentativeQuality(paper: string, includeTitle = false): Promise<Buffer> {
  const staffLines = [120, 132, 144, 156, 168, 210, 222, 234, 246, 258]
    .map((y) => `<line x1="40" y1="${y}" x2="920" y2="${y}" stroke="black" stroke-width="2"/>`)
    .join("");
  const title = includeTitle ? '<text x="320" y="72" font-size="34">Small notes: 1961</text>' : "";
  const svg = Buffer.from(`<svg width="960" height="360" xmlns="http://www.w3.org/2000/svg">
    <rect width="960" height="360" fill="${paper}"/>
    ${title}
    ${staffLines}
    <ellipse cx="220" cy="120" rx="22" ry="14" fill="rgb(145, 145, 145)"/>
    <line x1="240" y1="120" x2="240" y2="72" stroke="rgb(145, 145, 145)" stroke-width="5"/>
    <ellipse cx="610" cy="238" rx="22" ry="14" fill="black"/>
    <line x1="630" y1="238" x2="630" y2="190" stroke="black" stroke-width="5"/>
  </svg>`);
  return sharp(svg).png().toBuffer();
}

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

async function scoreWithRightAlignedComposerName(): Promise<Buffer> {
  const staffLines = [120, 132, 144, 156, 168, 210, 222, 234, 246, 258]
    .map((y) => `<line x1="40" y1="${y}" x2="920" y2="${y}" stroke="black" stroke-width="2"/>`)
    .join("");
  const svg = Buffer.from(`<svg width="960" height="420" xmlns="http://www.w3.org/2000/svg">
    <rect width="960" height="420" fill="white"/>
    <text x="710" y="92" font-size="28">Frédéric Chopin</text>
    ${staffLines}
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
