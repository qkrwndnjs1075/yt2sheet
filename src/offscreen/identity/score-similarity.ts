import {
  MAYBE_ASPECT_DIFF,
  MAYBE_CONTENT_DHASH_DISTANCE,
  MAYBE_CONTENT_PHASH_DISTANCE,
  MAYBE_HORIZONTAL_PROJECTION_SIMILARITY,
  MAYBE_INK_DENSITY_DIFF,
  MAYBE_VERTICAL_PROJECTION_SIMILARITY,
  SAME_ASPECT_DIFF,
  SAME_CONTENT_DHASH_DISTANCE,
  SAME_CONTENT_PHASH_DISTANCE,
  SAME_HORIZONTAL_PROJECTION_SIMILARITY,
  SAME_VERTICAL_PROJECTION_SIMILARITY,
  type SameScoreDecision,
  type ScoreFingerprint,
  type ScoreSimilarityDebug,
  type ScoreSimilarityMetrics,
  type ScoreSimilarityResult
} from "../../shared/fingerprint-types";

export class ScoreSimilarityService {
  compare(current: ScoreFingerprint, target: ScoreFingerprint): ScoreSimilarityResult {
    const debug = compareScoreFingerprints(current, target);
    const { decision, confidence: _confidence, ...metrics } = debug;

    return {
      decision,
      confidence: calculateConfidence(metrics, decision),
      metrics
    };
  }
}

export function decideSameScore(current: ScoreFingerprint, previous: ScoreFingerprint): SameScoreDecision {
  return compareScoreFingerprints(current, previous).decision;
}

export function compareScoreFingerprints(current: ScoreFingerprint, previous: ScoreFingerprint): ScoreSimilarityDebug {
  const fullPHashDistance = hammingDistance(current.fullPHash, previous.fullPHash);
  const fullDHashDistance = hammingDistance(current.fullDHash, previous.fullDHash);
  const contentPHashDistance = hammingDistance(current.contentPHash, previous.contentPHash);
  const contentDHashDistance = hammingDistance(current.contentDHash, previous.contentDHash);
  const verticalProjectionSimilarity = cosineSimilarity(current.verticalProjection, previous.verticalProjection);
  const horizontalProjectionSimilarity = cosineSimilarity(current.horizontalProjection, previous.horizontalProjection);
  const aspectDiff = Math.abs(current.aspectRatio - previous.aspectRatio);
  const inkDensityDiff = Math.abs(current.inkDensity - previous.inkDensity);
  const decision = decideFromScores({
    contentPHashDistance,
    contentDHashDistance,
    verticalProjectionSimilarity,
    horizontalProjectionSimilarity,
    aspectDiff,
    inkDensityDiff
  });

  return {
    decision,
    confidence: calculateConfidence({
      fullPHashDistance,
      fullDHashDistance,
      contentPHashDistance,
      contentDHashDistance,
      verticalProjectionSimilarity,
      horizontalProjectionSimilarity,
      aspectDiff,
      inkDensityDiff
    }, decision),
    fullPHashDistance,
    fullDHashDistance,
    contentPHashDistance,
    contentDHashDistance,
    verticalProjectionSimilarity,
    horizontalProjectionSimilarity,
    aspectDiff,
    inkDensityDiff
  };
}

function calculateConfidence(metrics: ScoreSimilarityMetrics, decision: SameScoreDecision): number {
  const hashScore = 1 - Math.min(metrics.contentPHashDistance / MAYBE_CONTENT_PHASH_DISTANCE, 1);
  const dHashScore = 1 - Math.min(metrics.contentDHashDistance / MAYBE_CONTENT_DHASH_DISTANCE, 1);
  const verticalScore = Math.min(metrics.verticalProjectionSimilarity, 1);
  const aspectScore = 1 - Math.min(metrics.aspectDiff / MAYBE_ASPECT_DIFF, 1);
  const base = (hashScore + dHashScore + verticalScore + aspectScore) / 4;

  if (decision === "same") {
    return Math.max(0.8, base);
  }

  if (decision === "maybe_same") {
    return Math.min(0.79, Math.max(0.45, base));
  }

  return Math.max(0, Math.min(0.99, 1 - base));
}

export function hammingDistance(a: string, b: string): number {
  const maxLength = Math.max(a.length, b.length);
  let distance = 0;

  for (let i = 0; i < maxLength; i += 1) {
    const left = Number.parseInt(a[i] ?? "0", 16);
    const right = Number.parseInt(b[i] ?? "0", 16);
    distance += bitCount((Number.isFinite(left) ? left : 0) ^ (Number.isFinite(right) ? right : 0));
  }

  return distance;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < length; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }

  if (normA === 0 && normB === 0) {
    return 1;
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function decideFromScores(scores: {
  contentPHashDistance: number;
  contentDHashDistance: number;
  verticalProjectionSimilarity: number;
  horizontalProjectionSimilarity: number;
  aspectDiff: number;
  inkDensityDiff: number;
}): SameScoreDecision {
  if (
    scores.contentPHashDistance <= SAME_CONTENT_PHASH_DISTANCE &&
    scores.contentDHashDistance <= SAME_CONTENT_DHASH_DISTANCE &&
    scores.verticalProjectionSimilarity >= SAME_VERTICAL_PROJECTION_SIMILARITY &&
    scores.horizontalProjectionSimilarity >= SAME_HORIZONTAL_PROJECTION_SIMILARITY &&
    scores.aspectDiff <= SAME_ASPECT_DIFF
  ) {
    return "same";
  }

  if (
    scores.contentPHashDistance <= MAYBE_CONTENT_PHASH_DISTANCE &&
    scores.contentDHashDistance <= MAYBE_CONTENT_DHASH_DISTANCE &&
    scores.verticalProjectionSimilarity >= MAYBE_VERTICAL_PROJECTION_SIMILARITY &&
    scores.horizontalProjectionSimilarity >= MAYBE_HORIZONTAL_PROJECTION_SIMILARITY &&
    scores.aspectDiff <= MAYBE_ASPECT_DIFF &&
    scores.inkDensityDiff <= MAYBE_INK_DENSITY_DIFF
  ) {
    return "maybe_same";
  }

  return "different";
}

function bitCount(value: number): number {
  let count = 0;
  let current = value & 0xf;
  while (current > 0) {
    count += current & 1;
    current >>= 1;
  }
  return count;
}
