import assert from "node:assert/strict";
import { test } from "node:test";
import type { DetectedSystem, ScoreRegionProposal } from "../src/shared/layout-types.js";
import { PreviousPositionFallback } from "../src/offscreen/layout/previous-position-fallback.js";
import { ScoreRegionProposalGenerator, isWeakProposal } from "../src/offscreen/layout/score-region-proposal-generator.js";
import { TemporalRegionTracker } from "../src/offscreen/layout/temporal-region-tracker.js";
import type { PreprocessedFrame } from "../src/offscreen/layout/preprocessed-frame.js";

test("bright-panel proposal remains as a weak candidate instead of being discarded", () => {
  const proposals = new ScoreRegionProposalGenerator().generate(makeBrightPanelFrame());
  const weak = proposals.filter(isWeakProposal);

  assert.ok(proposals.length > 0);
  assert.ok(weak.length > 0);
  assert.equal(weak[0].source, "bright_panel");
});

test("temporal tracker promotes repeated weak candidates", () => {
  const tracker = new TemporalRegionTracker();
  const proposal = makeWeakProposal();

  assert.equal(tracker.update(1, 1, [proposal])[0].status, "weak");
  assert.equal(tracker.update(2, 1.4, [proposal])[0].status, "weak");
  const promoted = tracker.update(3, 1.8, [proposal])[0];

  assert.equal(promoted.status, "promoted");
  assert.equal(promoted.source, "temporal_stable");
  assert.equal(tracker.getDebugInfo().stableRegionCount, 1);
});

test("previous-position fallback returns a short-lived unknown system", () => {
  const fallback = new PreviousPositionFallback();
  fallback.update([makeSystem()], 10);

  const systems = fallback.tryGet(11);

  assert.equal(systems.length, 1);
  assert.equal(systems[0].kind, "unknown");
  assert.equal(systems[0].source, "previous_position_fallback");
});

function makeBrightPanelFrame(): PreprocessedFrame {
  const width = 320;
  const height = 180;
  const rowDarkCounts = Array.from({ length: height }, () => 0);
  const rowLineScores = Array.from({ length: height }, () => 0);
  const rowEdgeScores = Array.from({ length: height }, () => 0);
  const rowBrightCounts = Array.from({ length: height }, () => 0);

  for (let y = 40; y < 110; y += 1) {
    rowBrightCounts[y] = 260;
    rowEdgeScores[y] = 0.045;
  }

  return {
    frameId: "bright-panel",
    width,
    height,
    originalWidth: width,
    originalHeight: height,
    sourceRect: { x: 0, y: 0, width, height },
    analysisScale: 1,
    binary: new Uint8Array(width * height),
    rowDarkCounts,
    rowLineScores,
    rowEdgeScores,
    rowBrightCounts,
    threshold: 180
  };
}

function makeWeakProposal(): ScoreRegionProposal {
  return {
    id: "proposal_1",
    rect: { x: 10, y: 20, width: 200, height: 80 },
    source: "bright_panel",
    ruleScores: {
      horizontalLineScore: 0.2,
      brightPanelScore: 0.8,
      edgeDensityScore: 0.2,
      aspectRatioScore: 0.8,
      contrastScore: 0.2,
      finalRuleScore: 0.45
    },
    finalScores: {
      ruleScore: 0.45,
      aiScore: 0,
      temporalStabilityScore: 0,
      finalScore: 0.45
    },
    scores: {
      horizontalLineScore: 0.2,
      brightPanelScore: 0.8,
      edgeDensityScore: 0.2,
      aspectRatioScore: 0.8,
      contrastScore: 0.2,
      temporalStabilityScore: 0,
      finalScore: 0.45
    },
    status: "weak"
  };
}

function makeSystem(): DetectedSystem {
  return {
    id: "sys_1",
    rect: { x: 10, y: 20, width: 200, height: 80 },
    kind: "single_staff",
    staffCandidates: [],
    confidence: 0.7,
    source: "staff_grouping",
    groupingReason: {
      staffCount: 1,
      xAlignmentScore: 1,
      widthSimilarityScore: 1,
      verticalGapScore: 1
    }
  };
}
