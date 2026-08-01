import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aggregateAssetValuesBySourceGroup, bootstrapPairedGroupDeltas, computeBoundaryRecall,
  computeUniqueStateRecall, createMulberry32, evaluatePromotion, type BenchmarkGroupEligibility
} from "../benchmarks/metrics";

const REQUIRED_TAGS = ["static", "cursor", "scroll", "hard-turn", "fade", "compression", "no-score"] as const;

function eligibleGroups(): readonly BenchmarkGroupEligibility[] {
  return Array.from({ length: 30 }, (_, index) => ({
    sourceGroupId: `group-${index}`,
    split: index < 10 ? "calibration" as const : "test" as const,
    approved: true,
    classTags: index < 10 ? ["static"] : REQUIRED_TAGS
  }));
}

describe("benchmark metrics", () => {
  it("counts half-open unique states and returns null for an empty denominator", () => {
    // Given
    const states = [{ stateId: "a", startMs: 0, endMs: 100 }, { stateId: "b", startMs: 100, endMs: 200 }];
    // When
    const populated = computeUniqueStateRecall([99, 200], states);
    const empty = computeUniqueStateRecall([0], []);
    // Then
    assert.deepEqual(populated, { numerator: 1, denominator: 2, ratio: 0.5 });
    assert.deepEqual(empty, { numerator: 0, denominator: 0, ratio: null });
  });

  it("greedily matches boundary pairs one-to-one by distance then boundary then candidate", () => {
    // Given
    const candidates = [100, 300];
    // When
    const twoMatches = computeBoundaryRecall(candidates, [{ timestampMs: 200 }, { timestampMs: 600 }]);
    const oneCandidate = computeBoundaryRecall([100], [{ timestampMs: 0 }, { timestampMs: 200 }]);
    const empty = computeBoundaryRecall([], []);
    // Then
    assert.deepEqual(twoMatches, { numerator: 2, denominator: 2, ratio: 1 });
    assert.deepEqual(oneCandidate, { numerator: 1, denominator: 2, ratio: 0.5 });
    assert.deepEqual(empty, { numerator: 0, denominator: 0, ratio: null });
  });

  it("averages assets within groups before computing the group macro", () => {
    // Given
    const values = [
      { assetId: "a1", sourceGroupId: "a", value: 0.5 }, { assetId: "a2", sourceGroupId: "a", value: 1 },
      { assetId: "b1", sourceGroupId: "b", value: 0 }, { assetId: "b2", sourceGroupId: "b", value: null }
    ];
    // When
    const result = aggregateAssetValuesBySourceGroup(values);
    // Then
    assert.deepEqual(result, { groups: [{ sourceGroupId: "a", value: 0.75 }, { sourceGroupId: "b", value: 0 }], macro: 0.375 });
  });

  it("matches the independently known Mulberry32 uint vector", () => {
    // Given
    const random = createMulberry32(20_260_724);
    // When
    const actual = Array.from({ length: 5 }, () => random.nextUint32());
    // Then
    assert.deepEqual(actual, [2_557_351_710, 3_665_214_136, 3_671_119_092, 3_467_818_820, 4_197_383_541]);
  });

  it("runs exactly 10000 paired group bootstrap replicates with R-7 intervals and null gates", () => {
    // Given
    const seed = 20_260_724;
    // When
    const fixed = bootstrapPairedGroupDeltas([1], seed);
    const missing = bootstrapPairedGroupDeltas([null, null], seed);
    // Then
    assert.deepEqual(fixed, { replicateCount: 10_000, lower95: 1, upper95: 1 });
    assert.deepEqual(missing, { replicateCount: 0, lower95: null, upper95: null });
  });

  it("returns exit 4 for external eligibility or promotion gate failures", () => {
    // Given
    const passingIntervals = {
      stateRecall: { replicateCount: 10_000, lower95: 0, upper95: 0.2 },
      boundaryRecall: { replicateCount: 10_000, lower95: 0.01, upper95: 0.3 },
      candidateDelta: { replicateCount: 10_000, lower95: -2, upper95: 0 }
    };
    // When
    const passing = evaluatePromotion({ claimTier: "external-gated", groups: eligibleGroups(), calibrationTunedDuringRun: false, everyCaseWithinBudget: true, bootstrap: passingIntervals });
    const ineligible = evaluatePromotion({ claimTier: "external-gated", groups: eligibleGroups().slice(0, 29), calibrationTunedDuringRun: false, everyCaseWithinBudget: true, bootstrap: passingIntervals });
    const failedGate = evaluatePromotion({ claimTier: "external-gated", groups: eligibleGroups(), calibrationTunedDuringRun: false, everyCaseWithinBudget: false, bootstrap: { ...passingIntervals, candidateDelta: { replicateCount: 10_000, lower95: -1, upper95: 0.01 } } });
    // Then
    assert.deepEqual(passing, { exitCode: 0, eligible: true, promotionPassed: true, qualityClaimsAllowed: true, gateFailures: [] });
    assert.equal(ineligible.exitCode, 4);
    assert.equal(ineligible.eligible, false);
    assert.equal(failedGate.exitCode, 4);
    assert.deepEqual(failedGate.gateFailures, ["candidate-delta-upper95", "case-budget"]);
  });

  it("keeps synthetic runs mechanics-only with no quality claim", () => {
    // Given
    const emptyInterval = { replicateCount: 0, lower95: null, upper95: null };
    // When
    const result = evaluatePromotion({
      claimTier: "mechanics-only", groups: [], calibrationTunedDuringRun: false,
      everyCaseWithinBudget: false,
      bootstrap: { stateRecall: emptyInterval, boundaryRecall: emptyInterval, candidateDelta: emptyInterval }
    });
    // Then
    assert.deepEqual(result, { exitCode: 0, eligible: false, promotionPassed: false, qualityClaimsAllowed: false, gateFailures: [] });
  });
});
