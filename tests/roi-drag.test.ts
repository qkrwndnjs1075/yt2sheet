import assert from "node:assert/strict";
import { test } from "node:test";
import { beginRoiDrag, updateRoiDrag } from "../src/shared/roi-drag.js";

const bounds = { left: 100, top: 50, width: 800, height: 450 };

test("dragging from inside an existing ROI moves it instead of replacing it", () => {
  const existingRect = { left: 200, top: 120, width: 300, height: 160 };
  const drag = beginRoiDrag({ x: 260, y: 170 }, existingRect, bounds);

  assert.equal(drag.mode, "move");
  assert.deepEqual(updateRoiDrag(drag, { x: 360, y: 220 }, bounds), {
    left: 300,
    top: 170,
    width: 300,
    height: 160
  });
});

test("dragging outside the existing ROI draws a new rectangle", () => {
  const existingRect = { left: 200, top: 120, width: 300, height: 160 };
  const drag = beginRoiDrag({ x: 620, y: 300 }, existingRect, bounds);

  assert.equal(drag.mode, "draw");
  assert.deepEqual(updateRoiDrag(drag, { x: 460, y: 180 }, bounds), {
    left: 460,
    top: 180,
    width: 160,
    height: 120
  });
});
