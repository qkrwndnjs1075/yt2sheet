import type { CandidateJudgeLabel, Rect, ScoreRegionProposal } from "../../../shared/layout-types";

export const MAX_CANDIDATES_PER_CONTACT_SHEET = 12;
export const CONTACT_SHEET_CELL_SIZE = 256;
export const AI_JUDGE_MIN_INTERVAL_MS = 1500;
export const AI_RESULT_CACHE_TTL_MS = 3000;
export const AI_JUDGE_ONLY_WHEN_CANDIDATES_CHANGED = true;

export type CandidateForJudge = {
  id: string;
  proposalId: string;
  rect: Rect;
  source: ScoreRegionProposal["source"];
  ruleScore: number;
};

export type ClaudeCandidateJudgeCandidate = {
  candidateId: string;
  label: CandidateJudgeLabel;
  isScoreCandidate: boolean;
  confidence: number;
  reason: string;
};

export type ClaudeCandidateJudgeResult = {
  candidates: ClaudeCandidateJudgeCandidate[];
};

export type CandidateJudgeResultForProposal = ClaudeCandidateJudgeCandidate & {
  proposalId: string;
};

export type CandidateContactSheet = {
  base64: string;
  mediaType: "image/jpeg" | "image/png";
  candidateIds: string[];
  width: number;
  height: number;
};

const LABELS = new Set<CandidateJudgeLabel>([
  "score_system",
  "score_region",
  "piano_keyboard",
  "hands",
  "subtitle_or_ui",
  "background",
  "unknown"
]);

export function isCandidateJudgeLabel(value: unknown): value is CandidateJudgeLabel {
  return typeof value === "string" && LABELS.has(value as CandidateJudgeLabel);
}

export function normalizeJudgeCandidate(value: unknown): ClaudeCandidateJudgeCandidate | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.candidateId !== "string" || !isCandidateJudgeLabel(candidate.label)) {
    return null;
  }

  const confidence = typeof candidate.confidence === "number" ? candidate.confidence : 0;
  const isScoreCandidate = typeof candidate.isScoreCandidate === "boolean"
    ? candidate.isScoreCandidate
    : candidate.label === "score_system" || candidate.label === "score_region";

  return {
    candidateId: candidate.candidateId,
    label: candidate.label,
    isScoreCandidate,
    confidence: Math.max(0, Math.min(1, confidence)),
    reason: typeof candidate.reason === "string" ? candidate.reason : ""
  };
}

export function parseClaudeCandidateJudgeResult(value: unknown): ClaudeCandidateJudgeResult {
  if (typeof value !== "object" || value === null || !Array.isArray((value as { candidates?: unknown }).candidates)) {
    throw new Error("AI judge response does not contain candidates[].");
  }

  const candidates = ((value as { candidates: unknown[] }).candidates)
    .map(normalizeJudgeCandidate)
    .filter((candidate): candidate is ClaudeCandidateJudgeCandidate => candidate !== null);

  if (candidates.length === 0) {
    throw new Error("AI judge response did not include any valid candidate labels.");
  }

  return { candidates };
}
