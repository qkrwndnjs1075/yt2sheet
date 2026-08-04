import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatResolvedScoreTimeRange, resolveScoreTimeRange } from "../pipeline/score-time-range";

describe("score time range resolver", () => {
  it("rejects non-finite and nonpositive source durations before resolving a range", () => {
    // Given
    const invalidDurations = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -0.5];

    // When
    const attempts = invalidDurations.map((sourceDurationSec) => () => resolveScoreTimeRange(undefined, sourceDurationSec));

    // Then
    for (const attempt of attempts) {
      assert.throws(attempt, RangeError);
    }
  });

  it("rejects an end-only range when the source duration is infinite", () => {
    // Given
    const range = { endTimeSec: 30 };

    // When
    const resolve = () => resolveScoreTimeRange(range, Number.POSITIVE_INFINITY);

    // Then
    assert.throws(resolve, RangeError);
  });

  it("resolves an omitted range to the full source interval", () => {
    // Given
    const durationSec = 120;

    // When
    const result = resolveScoreTimeRange(undefined, durationSec);

    // Then
    assert.deepEqual(result, {
      kind: "full",
      startTimeSec: 0,
      endTimeSec: 120,
      sampleDurationSec: 120,
      hasStartBound: false,
      hasEndBound: false
    });
  });

  it("resolves a start-only range while preserving its bound flag", () => {
    // Given
    const range = { startTimeSec: 12.5 };

    // When
    const result = resolveScoreTimeRange(range, 30);

    // Then
    assert.deepEqual(result, {
      kind: "explicit",
      startTimeSec: 12.5,
      endTimeSec: 30,
      sampleDurationSec: 17.5,
      hasStartBound: true,
      hasEndBound: false
    });
  });

  it("resolves an end-only range while preserving its bound flag", () => {
    // Given
    const range = { endTimeSec: 27.25 };

    // When
    const result = resolveScoreTimeRange(range, 30);

    // Then
    assert.deepEqual(result, {
      kind: "explicit",
      startTimeSec: 0,
      endTimeSec: 27.25,
      sampleDurationSec: 27.25,
      hasStartBound: false,
      hasEndBound: true
    });
  });

  it("preserves fractional start and end bounds", () => {
    // Given
    const range = { startTimeSec: 12.5, endTimeSec: 27.25 };

    // When
    const result = resolveScoreTimeRange(range, 30);

    // Then
    assert.deepEqual(result, {
      kind: "explicit",
      startTimeSec: 12.5,
      endTimeSec: 27.25,
      sampleDurationSec: 14.75,
      hasStartBound: true,
      hasEndBound: true
    });
  });

  it("rejects non-finite and negative start bounds", () => {
    // Given
    const invalidStarts = [Number.NaN, Number.POSITIVE_INFINITY, -0.5];

    // When
    const results = invalidStarts.map((startTimeSec) => resolveScoreTimeRange({ startTimeSec }, 30));

    // Then
    for (const result of results) {
      assert.deepEqual(result, { kind: "invalid", reason: "INVALID_START" });
    }
  });

  it("rejects non-finite and negative end bounds", () => {
    // Given
    const invalidEnds = [Number.NaN, Number.NEGATIVE_INFINITY, -0.5];

    // When
    const results = invalidEnds.map((endTimeSec) => resolveScoreTimeRange({ endTimeSec }, 30));

    // Then
    for (const result of results) {
      assert.deepEqual(result, { kind: "invalid", reason: "INVALID_END" });
    }
  });

  it("rejects a start at or beyond the source duration", () => {
    // Given
    const range = { startTimeSec: 30 };

    // When
    const result = resolveScoreTimeRange(range, 30);

    // Then
    assert.deepEqual(result, { kind: "invalid", reason: "START_OUT_OF_BOUNDS" });
  });

  it("rejects an end that does not follow the resolved start", () => {
    // Given
    const range = { startTimeSec: 12.5, endTimeSec: 12.5 };

    // When
    const result = resolveScoreTimeRange(range, 30);

    // Then
    assert.deepEqual(result, { kind: "invalid", reason: "END_NOT_AFTER_START" });
  });

  it("rejects an end beyond the source duration", () => {
    // Given
    const range = { endTimeSec: 30.001 };

    // When
    const result = resolveScoreTimeRange(range, 30);

    // Then
    assert.deepEqual(result, { kind: "invalid", reason: "END_OUT_OF_BOUNDS" });
  });

  it("accepts an end exactly at the source duration", () => {
    // Given
    const range = { endTimeSec: 30 };

    // When
    const result = resolveScoreTimeRange(range, 30);

    // Then
    assert.deepEqual(result, {
      kind: "explicit",
      startTimeSec: 0,
      endTimeSec: 30,
      sampleDurationSec: 30,
      hasStartBound: false,
      hasEndBound: true
    });
  });

  it("formats resolved ranges as readable timecodes", () => {
    // Given
    const result = resolveScoreTimeRange({ startTimeSec: 83.5, endTimeSec: 3723 }, 4_000);
    if (result.kind === "invalid") assert.fail(`fixture range failed to resolve: ${result.reason}`);

    // When
    const formatted = formatResolvedScoreTimeRange(result);

    // Then
    assert.equal(formatted, "[01:23.5, 1:02:03)");

    const fullRange = resolveScoreTimeRange(undefined, 4_000);
    if (fullRange.kind === "invalid") assert.fail(`fixture range failed to resolve: ${fullRange.reason}`);
    assert.equal(formatResolvedScoreTimeRange(fullRange), "[00:00, 1:06:40)");
  });
});
