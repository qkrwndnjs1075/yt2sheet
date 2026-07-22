import type { Rect } from "../../../shared/layout-types";
import type { CandidateForJudge, ClaudeCandidateJudgeCandidate } from "./candidate-judge-types";
import { AI_RESULT_CACHE_TTL_MS } from "./candidate-judge-types";

export type AiJudgeCacheKey = string;

export type AiJudgeCacheEntry = {
  key: AiJudgeCacheKey;
  result: ClaudeCandidateJudgeCandidate;
  createdAt: number;
  expiresAt: number;
};

export type CachedJudgeResult = {
  key: AiJudgeCacheKey;
  result: ClaudeCandidateJudgeCandidate;
};

export class AiJudgeCache {
  private readonly entries = new Map<AiJudgeCacheKey, AiJudgeCacheEntry>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  get(videoId: string, candidate: CandidateForJudge): CachedJudgeResult | null {
    const key = makeAiJudgeCacheKey(videoId, candidate.rect, candidate.source);
    const entry = this.entries.get(key);
    const now = this.now();

    if (!entry || entry.expiresAt <= now) {
      if (entry) {
        this.entries.delete(key);
      }
      return null;
    }

    return {
      key,
      result: {
        ...entry.result,
        candidateId: candidate.id
      }
    };
  }

  set(videoId: string, candidate: CandidateForJudge, result: ClaudeCandidateJudgeCandidate): AiJudgeCacheEntry {
    const now = this.now();
    const key = makeAiJudgeCacheKey(videoId, candidate.rect, candidate.source);
    const entry: AiJudgeCacheEntry = {
      key,
      result: { ...result, candidateId: candidate.id },
      createdAt: now,
      expiresAt: now + AI_RESULT_CACHE_TTL_MS
    };
    this.entries.set(key, entry);
    return entry;
  }

  clear(): void {
    this.entries.clear();
  }
}

export function makeAiJudgeCacheKey(videoId: string, rect: Rect, source: CandidateForJudge["source"]): AiJudgeCacheKey {
  const roundedRect = [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value / 16) * 16).join(",");
  return `${videoId}:${source}:${roundedRect}`;
}

