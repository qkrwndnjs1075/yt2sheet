import assert from "node:assert/strict";
import { test } from "node:test";
import type { CaptureState } from "../src/shared/types.js";

test("capture state model includes required lifecycle states", () => {
  const states: CaptureState[] = ["idle", "starting", "running", "paused", "stopping", "stopped", "completed", "error"];

  assert.deepEqual(states, ["idle", "starting", "running", "paused", "stopping", "stopped", "completed", "error"]);
});
