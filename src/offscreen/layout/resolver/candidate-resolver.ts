import { clamp } from "../../../shared/geometry";
import type { ScoreRegionProposal } from "../../../shared/layout-types";

const WEAK_THRESHOLD = 0.35;
const PROMOTION_THRESHOLD = 0.65;

export class CandidateResolver {
  resolve(proposals: ScoreRegionProposal[]): ScoreRegionProposal[] {
    return proposals.map(resolveProposal);
  }
}

function resolveProposal(proposal: ScoreRegionProposal): ScoreRegionProposal {
  const ruleScore = proposal.ruleScores.finalRuleScore;
  const temporalStabilityScore = proposal.scores.temporalStabilityScore ?? proposal.finalScores.temporalStabilityScore;
  const finalScore = clamp(Math.max(ruleScore, 0.8 * ruleScore + 0.2 * temporalStabilityScore), 0, 1);
  const next: ScoreRegionProposal = {
    ...proposal,
    finalScores: {
      ruleScore,
      temporalStabilityScore,
      finalScore
    },
    scores: {
      ...proposal.scores,
      temporalStabilityScore,
      finalScore
    },
    rejectReason: undefined
  };

  if (finalScore >= PROMOTION_THRESHOLD) {
    return { ...next, status: "promoted" };
  }

  if (finalScore >= WEAK_THRESHOLD || proposal.status === "promoted") {
    return { ...next, status: "weak" };
  }

  return {
    ...next,
    status: "rejected",
    rejectReason: "LOW_FINAL_SCORE",
    reason: "LOW_FINAL_SCORE"
  };
}
