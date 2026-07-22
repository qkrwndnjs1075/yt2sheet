import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanScorePixels, findSafeScoreCrop, type PixelFrame } from "../src/background/score-image-cleanup.js";
import { hasLargeFilledOverlay } from "../src/background/score-overlay-detection.js";

test("temporal cleanup removes transient overlay pixels without erasing persistent notation", () => {
  const covered = whiteFrame(16, 16);
  const clean = whiteFrame(16, 16);
  const secondClean = whiteFrame(16, 16);
  paintRect(covered, 2, 5, 12, 6, [24, 24, 24, 255]);
  paintRect(covered, 7, 7, 3, 3, [210, 30, 30, 255]);
  paintRect(covered, 11, 8, 2, 2, [250, 240, 80, 255]);
  paintRect(covered, 4, 11, 8, 1, [10, 10, 10, 255]);
  paintRect(clean, 4, 11, 8, 1, [10, 10, 10, 255]);
  paintRect(secondClean, 4, 11, 8, 1, [10, 10, 10, 255]);

  const result = cleanScorePixels(covered, [clean, secondClean]);

  assert.deepEqual(pixelAt(result.frame, 3, 7), [255, 255, 255, 255]);
  assert.deepEqual(pixelAt(result.frame, 8, 8), [255, 255, 255, 255]);
  assert.deepEqual(pixelAt(result.frame, 11, 8), [255, 255, 255, 255]);
  assert.deepEqual(pixelAt(result.frame, 6, 11), [10, 10, 10, 255]);
  assert.ok(result.repairedPixelCount > 0);
});

test("temporal cleanup ignores geometrically incompatible alternatives", () => {
  const covered = whiteFrame(16, 16);
  const incompatible = whiteFrame(12, 16);
  paintRect(covered, 2, 5, 12, 6, [24, 24, 24, 255]);

  const result = cleanScorePixels(covered, [incompatible]);

  assert.deepEqual(pixelAt(result.frame, 3, 7), [24, 24, 24, 255]);
  assert.equal(result.repairedPixelCount, 0);
});

test("safe crop removes uniform edge bands and excess margin while preserving every notation row", () => {
  const frame = whiteFrame(40, 32);
  paintRect(frame, 0, 0, 40, 3, [25, 25, 25, 255]);
  paintRect(frame, 0, 29, 40, 3, [250, 240, 80, 255]);
  for (const y of [10, 12, 14, 16, 18]) {
    paintRect(frame, 5, y, 30, 1, [20, 20, 20, 255]);
  }
  paintRect(frame, 7, 7, 3, 3, [20, 20, 20, 255]);
  paintRect(frame, 30, 19, 3, 3, [20, 20, 20, 255]);

  const crop = findSafeScoreCrop(frame);

  assert.ok(crop.y > 2, `expected top band to be removed, got y=${crop.y}`);
  assert.ok(crop.y + crop.height < 29, `expected bottom band to be removed, got bottom=${crop.y + crop.height}`);
  assert.ok(crop.y <= 7, `expected upper notation to remain, got y=${crop.y}`);
  assert.ok(crop.y + crop.height >= 22, `expected lower notation to remain, got bottom=${crop.y + crop.height}`);
});

test("safe crop removes a YouTube title band below a compact full-width TAB staff", () => {
  const frame = whiteFrame(1322, 222);
  for (const y of [54, 71, 88, 105, 122, 139]) {
    paintRect(frame, 64, y, 1200, 1, [190, 190, 190, 255]);
  }
  paintRect(frame, 0, 175, 25, 7, [80, 80, 80, 255]);
  paintRect(frame, 0, 182, 1322, 40, [42, 42, 42, 255]);
  paintRect(frame, 0, 201, 420, 16, [245, 245, 245, 255]);

  const crop = findSafeScoreCrop(frame);

  assert.ok(crop.y <= 54, `expected the first TAB line to remain, got y=${crop.y}`);
  assert.ok(crop.y + crop.height > 139, `expected the last TAB line to remain, got bottom=${crop.y + crop.height}`);
  assert.ok(crop.y + crop.height <= 182, `expected the YouTube title band to be removed, got bottom=${crop.y + crop.height}`);
});

test("cleanup whitens thick near-full-width separators while preserving score notation", () => {
  // Given: a white score with thin staff notation and a thick video separator across the ROI.
  const frame = whiteFrame(120, 64);
  for (const y of [10, 13, 16, 19, 22]) {
    paintRect(frame, 8, y, 104, 1, [30, 30, 30, 255]);
  }
  paintRect(frame, 26, 8, 3, 17, [20, 20, 20, 255]);
  paintRect(frame, 3, 42, 114, 6, [12, 12, 12, 255]);

  // When: the frame passes through the real export pixel cleanup.
  const result = cleanScorePixels(frame, []);

  // Then: the separator becomes paper white while staff lines and the vertical notation mark remain.
  assert.deepEqual(pixelAt(result.frame, 60, 44), [255, 255, 255, 255]);
  assert.deepEqual(pixelAt(result.frame, 60, 16), [30, 30, 30, 255]);
  assert.deepEqual(pixelAt(result.frame, 27, 9), [20, 20, 20, 255]);
  assert.ok(result.repairedPixelCount >= 114 * 6);
});

test("cleanup normalizes paper-like ROI background to pure white without erasing colored marks", () => {
  // Given: an off-white paper background with black notation and a small colored annotation.
  const frame = whiteFrame(48, 32);
  paintRect(frame, 0, 0, 48, 32, [242, 240, 235, 255]);
  paintRect(frame, 6, 12, 36, 1, [24, 24, 24, 255]);
  paintRect(frame, 20, 8, 4, 4, [40, 90, 210, 255]);

  // When: the frame passes through export pixel cleanup.
  const result = cleanScorePixels(frame, []);

  // Then: paper becomes pure white while notation and intentional colored marks remain.
  assert.deepEqual(pixelAt(result.frame, 2, 2), [255, 255, 255, 255]);
  assert.deepEqual(pixelAt(result.frame, 10, 12), [24, 24, 24, 255]);
  assert.deepEqual(pixelAt(result.frame, 21, 9), [40, 90, 210, 255]);
});

test("unrecoverable filled overlays are rejected while thin staff notation is accepted", () => {
  const cleanStaff = whiteFrame(60, 32);
  for (const y of [10, 12, 14, 16, 18]) {
    paintRect(cleanStaff, 5, y, 50, 1, [20, 20, 20, 255]);
  }
  const darkOverlay = cloneFrame(cleanStaff);
  const colorOverlay = cloneFrame(cleanStaff);
  paintRect(darkOverlay, 22, 7, 16, 16, [35, 35, 35, 255]);
  paintRect(colorOverlay, 22, 7, 16, 16, [220, 40, 40, 255]);

  assert.equal(hasLargeFilledOverlay(cleanStaff), false);
  assert.equal(hasLargeFilledOverlay(darkOverlay), true);
  assert.equal(hasLargeFilledOverlay(colorOverlay), true);
});

function whiteFrame(width: number, height: number): PixelFrame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = 255;
    data[offset + 1] = 255;
    data[offset + 2] = 255;
    data[offset + 3] = 255;
  }
  return { width, height, data };
}

function paintRect(
  frame: PixelFrame,
  x: number,
  y: number,
  width: number,
  height: number,
  color: readonly [number, number, number, number]
): void {
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      const offset = (row * frame.width + column) * 4;
      frame.data.set(color, offset);
    }
  }
}

function cloneFrame(frame: PixelFrame): PixelFrame {
  return { width: frame.width, height: frame.height, data: new Uint8ClampedArray(frame.data) };
}

function pixelAt(frame: PixelFrame, x: number, y: number): number[] {
  const offset = (y * frame.width + x) * 4;
  return Array.from(frame.data.slice(offset, offset + 4));
}
