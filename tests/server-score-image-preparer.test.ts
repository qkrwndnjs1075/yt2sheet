import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import sharp from "sharp";
import { prepareScoreCrop } from "../server/score-image-preparer";

test("rejects a large colored intro overlay and removes source pillarboxes", async (t) => {
  const directory = await createTempDirectory(t);
  const overlaid = join(directory, "overlaid.png");
  const clean = join(directory, "clean.png");
  await Promise.all([
    writePillarboxedScoreFrame(overlaid, true),
    writePillarboxedScoreFrame(clean, false)
  ]);

  const [overlaidImage, cleanImage] = await Promise.all([readRawImage(overlaid), readRawImage(clean)]);
  const overlaidCrop = prepareScoreCrop(overlaidImage.data, overlaidImage.info, fullCrop(overlaidImage.info));
  const cleanCrop = prepareScoreCrop(cleanImage.data, cleanImage.info, fullCrop(cleanImage.info));

  assert.equal(overlaidCrop, null, "the transient intro overlay was exported as a score");
  assert.equal(cleanCrop?.width, 720, "source-video pillarboxes remained in the score crop");
});

test("ignores colored source margins before classifying score overlays", async (t) => {
  const directory = await createTempDirectory(t);
  const frame = join(directory, "colored-margins.png");
  await writePillarboxedScoreFrame(frame, false, "rgb(30, 70, 190)");

  const image = await readRawImage(frame);
  const prepared = prepareScoreCrop(image.data, image.info, fullCrop(image.info));

  assert.equal(prepared?.width, 720, "colored source margins caused a clean score to be rejected");
});

async function readRawImage(path: string): Promise<{
  readonly data: Buffer;
  readonly info: { readonly width: number; readonly height: number; readonly channels: 3 };
}> {
  const { data, info } = await sharp(await readFile(path))
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error("Expected an RGB test image");
  return { data, info: { width: info.width, height: info.height, channels: info.channels } };
}

function fullCrop(info: { readonly width: number; readonly height: number }) {
  return { x: 0, y: 0, width: info.width, height: info.height, staffGap: 12 };
}

async function createTempDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "yt2sheet-image-preparer-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  return directory;
}

async function writePillarboxedScoreFrame(path: string, includeIntroOverlay: boolean, marginColor = "black"): Promise<void> {
  const lines = [90, 102, 114, 126, 138, 210, 222, 234, 246, 258]
    .map((y) => `<line x1="150" y1="${y}" x2="810" y2="${y}" stroke="black" stroke-width="2"/>`)
    .join("");
  const overlay = includeIntroOverlay ? `
    <text x="160" y="175" font-family="Arial" font-size="132" font-weight="700" fill="rgb(70, 20, 180)" fill-opacity="0.42">DISNEY</text>
    <text x="230" y="300" font-family="Arial" font-size="118" font-weight="700" fill="rgb(70, 20, 180)" fill-opacity="0.42">OPENING</text>` : "";
  const svg = Buffer.from(`<svg width="960" height="360" xmlns="http://www.w3.org/2000/svg">
    <rect width="960" height="360" fill="${marginColor}"/>
    <rect x="120" width="720" height="360" fill="white"/>
    ${lines}
    <ellipse cx="270" cy="120" rx="22" ry="14" fill="black"/>
    <line x1="290" y1="120" x2="290" y2="72" stroke="black" stroke-width="5"/>
    <ellipse cx="650" cy="238" rx="22" ry="14" fill="black"/>
    <line x1="670" y1="238" x2="670" y2="190" stroke="black" stroke-width="5"/>
    ${overlay}
  </svg>`);
  await sharp(svg).png().toFile(path);
}
