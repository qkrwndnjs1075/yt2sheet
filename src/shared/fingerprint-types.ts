import { SCORE_IDENTITY_CONFIG } from "./score-identity-config";

export const FINGERPRINT_WIDTH = SCORE_IDENTITY_CONFIG.fingerprint.width;
export const FINGERPRINT_HEIGHT = SCORE_IDENTITY_CONFIG.fingerprint.height;

export const SAME_CONTENT_PHASH_DISTANCE = SCORE_IDENTITY_CONFIG.similarity.sameContentPHashDistance;
export const MAYBE_CONTENT_PHASH_DISTANCE = SCORE_IDENTITY_CONFIG.similarity.maybeContentPHashDistance;
export const SAME_CONTENT_DHASH_DISTANCE = SCORE_IDENTITY_CONFIG.similarity.sameContentDHashDistance;
export const MAYBE_CONTENT_DHASH_DISTANCE = SCORE_IDENTITY_CONFIG.similarity.maybeContentDHashDistance;
export const SAME_VERTICAL_PROJECTION_SIMILARITY = SCORE_IDENTITY_CONFIG.similarity.sameVerticalProjectionSimilarity;
export const MAYBE_VERTICAL_PROJECTION_SIMILARITY = SCORE_IDENTITY_CONFIG.similarity.maybeVerticalProjectionSimilarity;
export const SAME_HORIZONTAL_PROJECTION_SIMILARITY = SCORE_IDENTITY_CONFIG.similarity.sameHorizontalProjectionSimilarity;
export const SAME_ASPECT_DIFF = SCORE_IDENTITY_CONFIG.similarity.sameAspectDiff;
export const MAYBE_ASPECT_DIFF = SCORE_IDENTITY_CONFIG.similarity.maybeAspectDiff;
export const MAYBE_HORIZONTAL_PROJECTION_SIMILARITY = SCORE_IDENTITY_CONFIG.similarity.maybeHorizontalProjectionSimilarity;
export const MAYBE_INK_DENSITY_DIFF = SCORE_IDENTITY_CONFIG.similarity.maybeInkDensityDiff;

export type ScoreFingerprint = {
  fullPHash: string;
  fullDHash: string;
  contentPHash: string;
  contentDHash: string;
  horizontalProjection: number[];
  verticalProjection: number[];
  aspectRatio: number;
  inkDensity: number;
};

export type SameScoreDecision = "same" | "maybe_same" | "different";

export type ScoreSimilarityMetrics = {
  fullPHashDistance: number;
  fullDHashDistance: number;
  contentPHashDistance: number;
  contentDHashDistance: number;
  verticalProjectionSimilarity: number;
  horizontalProjectionSimilarity: number;
  aspectDiff: number;
  inkDensityDiff: number;
};

export type ScoreSimilarityDebug = ScoreSimilarityMetrics & {
  decision: SameScoreDecision;
  confidence?: number;
};

export type ScoreSimilarityResult = {
  decision: SameScoreDecision;
  confidence: number;
  metrics: ScoreSimilarityMetrics;
};

export type NormalizedScoreImage = {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
};
