import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { STANDALONE_SCORE_PDF } from "../pipeline/score-identity-config";
import { createScorePdfFromFrames } from "../pipeline/score-video-processor";

test("generated PDF keeps score-sheet boundary gaps equal when detected staff gaps differ", async (t) => {
  // Given: three valid score frames whose detected staff gaps differ.
  const directory = await mkdtemp(join(tmpdir(), "yt2sheet-spacing-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    t.diagnostic(JSON.stringify({ directory, tempRemoved: true }));
  });
  const frames = [10, 14, 20].map((staffGap, index) => join(directory, `frame-${index + 1}.png`));
  await Promise.all(frames.map((path, index) => writeScoreFrame(path, [10, 14, 20][index], 170 + index * 230)));

  // When: the production media path normalizes and composes the score sheets.
  await createScorePdfFromFrames(frames, directory, join(directory, "result.pdf"), {
    metadata: { videoId: "spacing-test", createdAt: new Date("2026-07-24T00:00:00.000Z") }
  });
  const { data, info } = await sharp(join(directory, "pages", "page-0001.png"))
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const preset = STANDALONE_SCORE_PDF;
  const contentWidth = preset.rasterWidth - preset.padding * 2;
  const scanLeft = Math.round(preset.padding + contentWidth * 0.94);
  const scanRight = Math.min(preset.rasterWidth - 1, scanLeft + Math.round(contentWidth * 0.04));
  assert.equal(info.width, preset.rasterWidth);
  assert.equal(info.height, preset.rasterHeight);
  const boundaryRows = Array.from({ length: info.height }, (_, y) => {
    for (let x = scanLeft; x <= scanRight; x += 1) {
      if (data[y * info.width + x] < 245) return true;
    }
    return false;
  });
  const boundaries: Array<{ readonly top: number; readonly bottom: number }> = [];
  let top = -1;
  for (let y = 0; y <= boundaryRows.length; y += 1) {
    if (boundaryRows[y]) {
      top = top < 0 ? y : top;
      continue;
    }
    if (top >= 0 && y - top > 80) boundaries.push({ top, bottom: y - 1 });
    top = -1;
  }
  const gaps = boundaries.slice(1).map((boundary, index) => boundary.top - boundaries[index].bottom - 1);

  // Then: every adjacent score-sheet boundary has the same visible paper gap.
  assert.equal(boundaries.length, 3);
  assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 1, `uneven score-sheet gaps: ${gaps.join(", ")}`);
});

async function writeScoreFrame(path: string, staffGap: number, markerX: number): Promise<void> {
  const staffStarts = [80, 220];
  const lines = staffStarts
    .flatMap((start) => Array.from({ length: 5 }, (_, index) => start + index * staffGap))
    .map((y) => `<line x1="40" y1="${y}" x2="920" y2="${y}" stroke="black" stroke-width="2"/>`)
    .join("");
  const svg = Buffer.from(`<svg width="960" height="420" xmlns="http://www.w3.org/2000/svg">
    <rect width="960" height="420" fill="white"/>
    ${lines}
    <line x1="920" y1="40" x2="920" y2="360" stroke="black" stroke-width="1"/>
    <ellipse cx="${markerX}" cy="${80 + staffGap * 2}" rx="18" ry="12" fill="black"/>
    <line x1="${markerX + 16}" y1="${80 + staffGap * 2}" x2="${markerX + 16}" y2="${50 + staffGap * 2}" stroke="black" stroke-width="4"/>
  </svg>`);
  await sharp(svg).png().toFile(path);
}
