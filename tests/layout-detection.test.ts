import assert from "node:assert/strict";
import { test } from "node:test";
import type { Rect } from "../src/shared/layout-types.js";
import { ScaleEstimator } from "../src/offscreen/layout/scale-estimator.js";
import { ScoreRegionFinder } from "../src/offscreen/layout/score-region-finder.js";
import { StaffCandidateDetector } from "../src/offscreen/layout/staff-candidate-detector.js";
import { SystemGrouper } from "../src/offscreen/layout/system-grouper.js";
import { TemporalStabilizer } from "../src/offscreen/layout/temporal-stabilizer.js";
import type { PreprocessedFrame } from "../src/offscreen/layout/preprocessed-frame.js";

type SyntheticStaff = {
  y: number;
  lines: 5 | 6;
};

const WIDTH = 800;
const HEIGHT = 420;
const X_START = 80;
const X_END = 720;
const LINE_GAP = 8;

test("detects no score when no staff-like rows exist", () => {
  const result = runPipeline(makeFrame([]));

  assert.equal(result.regions.length, 0);
  assert.equal(result.staffs.length, 0);
  assert.equal(result.systems.length, 0);
});

test("groups one piano grand staff into one system", () => {
  const result = runPipeline(makeFrame([
    { y: 40, lines: 5 },
    { y: 98, lines: 5 }
  ]));

  assert.equal(result.staffs.length, 2);
  assert.equal(result.systems.length, 1);
  assert.equal(result.systems[0].kind, "grand_staff");
});

test("detects staff lines when the score occupies a smaller part of a YouTube tab capture", () => {
  const result = runPipeline(makeFrame(
    [
      { y: 40, lines: 5 },
      { y: 98, lines: 5 }
    ],
    { xStart: 170, xEnd: 330 }
  ));

  assert.equal(result.staffs.length, 2);
  assert.equal(result.systems.length, 1);
  assert.equal(result.systems[0].kind, "grand_staff");
});

test("keeps two piano grand staffs as two systems", () => {
  const result = runPipeline(makeFrame([
    { y: 36, lines: 5 },
    { y: 92, lines: 5 },
    { y: 206, lines: 5 },
    { y: 262, lines: 5 }
  ]));

  assert.equal(result.staffs.length, 4);
  assert.equal(result.systems.length, 2);
  assert.deepEqual(result.systems.map((system) => system.kind), ["grand_staff", "grand_staff"]);
});

test("keeps separated standard staffs as separate single-staff systems", () => {
  const result = runPipeline(makeFrame([
    { y: 40, lines: 5 },
    { y: 132, lines: 5 }
  ]));

  assert.equal(result.staffs.length, 2);
  assert.equal(result.systems.length, 2);
  assert.deepEqual(result.systems.map((system) => system.kind), ["single_staff", "single_staff"]);
});

test("detects each tab staff as its own system", () => {
  const result = runPipeline(makeFrame([
    { y: 42, lines: 6 },
    { y: 154, lines: 6 },
    { y: 266, lines: 6 }
  ]));

  assert.equal(result.staffs.length, 3);
  assert.equal(result.systems.length, 3);
  assert.deepEqual(result.systems.map((system) => system.kind), ["tab", "tab", "tab"]);
});

test("groups nearby standard staff and tab staff as tab_plus_staff", () => {
  const result = runPipeline(makeFrame([
    { y: 48, lines: 5 },
    { y: 108, lines: 6 }
  ]));

  assert.equal(result.staffs.length, 2);
  assert.equal(result.systems.length, 1);
  assert.equal(result.systems[0].kind, "tab_plus_staff");
});

test("stabilizes repeated system boxes across frames", () => {
  const stabilizer = new TemporalStabilizer();
  const first = runPipeline(makeFrame([{ y: 44, lines: 6 }])).systems;
  const second = runPipeline(makeFrame([{ y: 46, lines: 6 }])).systems;
  const third = runPipeline(makeFrame([{ y: 45, lines: 6 }])).systems;

  assert.equal(stabilizer.update(1, first)[0].id, "track_1");
  assert.equal(stabilizer.update(2, second)[0].id, "track_1");
  assert.equal(stabilizer.update(3, third)[0].id, "track_1");
  assert.equal(stabilizer.getDebugInfo().stableBoxCount, 1);
});

function runPipeline(frame: PreprocessedFrame) {
  const regions = new ScoreRegionFinder().find(frame);
  const staffs = new StaffCandidateDetector().find(frame, regions);
  const scale = new ScaleEstimator().estimate(staffs);
  const systems = new SystemGrouper().group(staffs, scale);

  return { regions, staffs, scale, systems };
}

function makeFrame(staffs: SyntheticStaff[], options: { xStart?: number; xEnd?: number } = {}): PreprocessedFrame {
  const binary = new Uint8Array(WIDTH * HEIGHT);
  const rowDarkCounts = Array.from({ length: HEIGHT }, () => 0);
  const rowLineScores = Array.from({ length: HEIGHT }, () => 0);
  const rowEdgeScores = Array.from({ length: HEIGHT }, () => 0);
  const rowBrightCounts = Array.from({ length: HEIGHT }, () => 0);
  const xStart = options.xStart ?? X_START;
  const xEnd = options.xEnd ?? X_END;

  for (const staff of staffs) {
    for (let line = 0; line < staff.lines; line += 1) {
      drawLine(binary, rowDarkCounts, rowLineScores, {
        x: xStart,
        y: staff.y + line * LINE_GAP,
        width: xEnd - xStart + 1,
        height: 1
      });
    }
  }

  return {
    frameId: "synthetic",
    width: WIDTH,
    height: HEIGHT,
    originalWidth: WIDTH,
    originalHeight: HEIGHT,
    sourceRect: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
    analysisScale: 1,
    binary,
    rowDarkCounts,
    rowLineScores,
    rowEdgeScores,
    rowBrightCounts,
    threshold: 180
  };
}

function drawLine(binary: Uint8Array, rowDarkCounts: number[], rowLineScores: number[], rect: Rect): void {
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      binary[y * WIDTH + x] = 1;
      rowDarkCounts[y] += 1;
    }
    rowLineScores[y] = rowDarkCounts[y] / WIDTH;
  }
}
