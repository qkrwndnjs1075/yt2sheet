import { clamp } from "../../../shared/geometry";
import type { CandidateJudgeLabel, ScoreRegionProposal } from "../../../shared/layout-types";
import type { CandidateJudgeResultForProposal } from "../ai/candidate-judge-types";

const WEAK_THRESHOLD = 0.35;
const PROMOTION_THRESHOLD = 0.65;
const STRONG_AI_REJECT_CONFIDENCE = 0.8;
const STRONG_AI_PROMOTE_CONFIDENCE = 0.75;
const WEAK_AI_CONFIDENCE = 0.65;

export class CandidateResolver {
  resolve(input: { proposals: ScoreRegionProposal[]; aiResults: CandidateJudgeResultForProposal[] }): ScoreRegionProposal[] {
    const aiByProposalId = new Map(input.aiResults.map((result) => [result.proposalId, result]));

    return input.proposals.map((proposal) => {
      const ai = aiByProposalId.get(proposal.id);
      return resolveProposal(proposal, ai);
    });
  }
}

function resolveProposal(proposal: ScoreRegionProposal, ai?: CandidateJudgeResultForProposal): ScoreRegionProposal {
  const effectiveAi: CandidateJudgeResultForProposal | undefined = ai ?? (proposal.ai
    ? {
        proposalId: proposal.id,
        candidateId: proposal.id,
        label: proposal.ai.label,
        isScoreCandidate: proposal.ai.isScoreCandidate,
        confidence: proposal.ai.confidence,
        reason: proposal.ai.reason
      }
    : undefined);
  const ruleScore = proposal.ruleScores?.finalRuleScore ?? proposal.scores.finalScore;
  const temporalStabilityScore = proposal.scores.temporalStabilityScore ?? proposal.finalScores?.temporalStabilityScore ?? 0;
  const aiScore = effectiveAi ? scoreAi(effectiveAi.label, effectiveAi.confidence) : proposal.finalScores?.aiScore ?? 0;
  const finalScore = effectiveAi
    ? clamp(0.6 * aiScore + 0.25 * ruleScore + 0.15 * temporalStabilityScore, 0, 1)
    : clamp(Math.max(ruleScore, 0.8 * ruleScore + 0.2 * temporalStabilityScore), 0, 1);
  const next: ScoreRegionProposal = {
    ...proposal,
    ai: effectiveAi
      ? {
          label: effectiveAi.label,
          isScoreCandidate: effectiveAi.isScoreCandidate,
          confidence: effectiveAi.confidence,
          reason: effectiveAi.reason
        }
      : proposal.ai,
    finalScores: {
      ruleScore,
      aiScore,
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

  if (effectiveAi && isStrongReject(effectiveAi.label) && effectiveAi.confidence >= STRONG_AI_REJECT_CONFIDENCE) {
    return {
      ...next,
      status: "rejected",
      rejectReason: rejectReasonFor(effectiveAi.label),
      reason: rejectReasonFor(effectiveAi.label)
    };
  }

  if (effectiveAi && isScoreLabel(effectiveAi.label) && effectiveAi.confidence >= STRONG_AI_PROMOTE_CONFIDENCE) {
    return {
      ...next,
      status: "promoted"
    };
  }

  if (effectiveAi && (effectiveAi.label === "unknown" || effectiveAi.confidence < WEAK_AI_CONFIDENCE || effectiveAi.label === "hands")) {
    return {
      ...next,
      status: "weak",
      reason: effectiveAi.label === "hands" ? "AI_HANDS_NEEDS_TEMPORAL_CONFIRMATION" : next.reason
    };
  }

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

function scoreAi(label: CandidateJudgeLabel, confidence: number): number {
  if (isScoreLabel(label)) {
    return confidence;
  }

  if (label === "unknown") {
    return 0.25 * confidence;
  }

  return 0;
}

function isScoreLabel(label: CandidateJudgeLabel): boolean {
  return label === "score_system" || label === "score_region";
}

function isStrongReject(label: CandidateJudgeLabel): boolean {
  return label === "piano_keyboard" || label === "subtitle_or_ui" || label === "background";
}

function rejectReasonFor(label: CandidateJudgeLabel): string {
  switch (label) {
    case "piano_keyboard":
      return "AI_PIANO_KEYBOARD";
    case "subtitle_or_ui":
      return "AI_SUBTITLE_OR_UI";
    case "background":
      return "AI_BACKGROUND";
    default:
      return "AI_REJECTED";
  }
}
