import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { shouldSamplePlaybackTick } from "../src/offscreen/frame-input-collector.js";
import type { VideoProbeTick } from "../src/shared/messages.js";

test("frame collection waits for an active playback tick", () => {
  assert.equal(shouldSamplePlaybackTick(null), false);
  assert.equal(shouldSamplePlaybackTick(tick(true)), false);
  assert.equal(shouldSamplePlaybackTick(tick(false)), true);
});

test("playback gating applies to sampling and never prevents cleanup", () => {
  const source = readFileSync(resolve(process.cwd(), "src/offscreen/frame-input-collector.ts"), "utf8");
  const stopBody = source.slice(source.indexOf("async stop("), source.indexOf("updateTiming("));
  const sampleBody = source.slice(source.indexOf("private async sampleFrame"), source.indexOf("private currentTimestampSec"));

  assert.doesNotMatch(stopBody, /shouldSamplePlaybackTick/);
  assert.match(sampleBody, /if \(!shouldSamplePlaybackTick\(current\.latestTick\)\)/);
});

test("capture completion waits for an in-flight frame delivery before announcing stop", () => {
  const source = readFileSync(resolve(process.cwd(), "src/offscreen/frame-input-collector.ts"), "utf8");
  const stopBody = source.slice(source.indexOf("async stop("), source.indexOf("updateTiming("));
  const sampleBody = source.slice(source.indexOf("private async sampleFrame"), source.indexOf("private currentTimestampSec"));

  assert.match(stopBody, /await current\.samplingCompleted/);
  assert.match(sampleBody, /current\.samplingCompleted = new Promise/);
  assert.match(sampleBody, /finishSampling\(\)/);
});

function tick(paused: boolean): VideoProbeTick {
  return {
    type: "VIDEO_PROBE_TICK",
    sessionId: "session_1",
    tabId: 1,
    videoId: "video_1",
    currentTimeSec: 1,
    durationSec: 100,
    paused,
    playbackRate: 1,
    wallClockAt: new Date(0).toISOString()
  };
}
