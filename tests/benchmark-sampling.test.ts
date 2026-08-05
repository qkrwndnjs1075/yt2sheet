import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";
import { buildControlSamplingPlan, buildTreatmentTimestamps, type ScoreEventTrace } from "../benchmarks/sampling-plan";
import { buildFrameExtractionArguments } from "../pipeline/youtube-score-processor";

describe("benchmark sampling plan", () => {
  it("builds the exact rounded control budget and characterizes production fps", () => {
    // Given
    const durationMs = 7_200_000;
    // When
    const plan = buildControlSamplingPlan(durationMs);
    // Then
    assert.equal(plan.intervalMs, 2_000);
    assert.equal(plan.productionFps, 0.5);
    assert.equal(plan.budget, 3_600);
    assert.equal(plan.timestampsMs[0], 0);
    assert.equal(plan.timestampsMs[3_599], 7_198_000);
    assert.deepEqual(buildFrameExtractionArguments("input.mp4", "frames", durationMs / 1_000), [
      "-hide_banner", "-loglevel", "error", "-i", "input.mp4", "-vf", "fps=0.5", "-q:v", "2", "-frames:v", "3600", join("frames", "frame-%06d.jpg")
    ]);
  });

  it("keeps the floor before ranked event neighborhoods can spend its budget", () => {
    // Given
    const trace: ScoreEventTrace = {
      schemaVersion: "score-events/1", assetId: "noisy",
      events: [
        { timestampMs: 1_499, score: 50 }, { timestampMs: 500, score: 50 },
        { timestampMs: 800, score: 11 }, { timestampMs: 100, score: 80 }
      ]
    };
    // When
    const selected = buildTreatmentTimestamps(1_600, trace);
    // Then
    assert.deepEqual(selected, [0, 100, 350, 1_000]);
  });

  it("uses score-descending time-ascending NMS with a strict 500ms exclusion", () => {
    // Given
    const trace: ScoreEventTrace = {
      schemaVersion: "score-events/1", assetId: "ties",
      events: [
        { timestampMs: 1_600, score: 30 }, { timestampMs: 1_100, score: 30 }, { timestampMs: 1_599, score: 29 }
      ]
    };
    // When
    const selected = buildTreatmentTimestamps(4_000, trace);
    // Then
    assert.deepEqual(selected, [0, 850, 1_000, 1_100, 1_350, 1_600, 2_000, 3_000]);
  });

  it("allows a partial final neighborhood and clamps and deduplicates integer endpoints", () => {
    // Given
    const trace: ScoreEventTrace = {
      schemaVersion: "score-events/1", assetId: "endpoint", events: [{ timestampMs: 2_500, score: 100 }]
    };
    // When
    const selected = buildTreatmentTimestamps(2_600, trace);
    // Then
    assert.deepEqual(selected, [0, 1_000, 2_000, 2_250, 2_500, 2_599]);
  });

  it("rejects event traces outside the strict integer score contract", () => {
    // Given
    const invalidTrace: ScoreEventTrace = {
      schemaVersion: "score-events/1", assetId: "invalid", events: [{ timestampMs: 10.5, score: 101 }]
    };
    // When
    const action = () => buildTreatmentTimestamps(1_000, invalidTrace);
    // Then
    assert.throws(action, RangeError);
  });
});
