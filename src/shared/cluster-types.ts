import type { ScoreFingerprint, ScoreSimilarityDebug } from "./fingerprint-types";
import type { EndGateStatus, RoiSample } from "./roi-types";
import { SCORE_IDENTITY_CONFIG } from "./score-identity-config";
export type { CapturedScoreSystem } from "./capture-types";

export const MIN_NEW_SCORE_INTERVAL_MS = SCORE_IDENTITY_CONFIG.sampling.minNewScoreIntervalMs;
export const MIN_STABLE_DURATION_MS = SCORE_IDENTITY_CONFIG.sampling.minStableDurationMs;
export const MIN_ACCEPT_SEEN_COUNT = SCORE_IDENTITY_CONFIG.cluster.minAcceptSeenCount;

export type ScoreClusterStatus = "pending" | "accepted" | "duplicate" | "rejected";

export type ScoreCluster = {
  id: string;
  sessionId: string;
  firstSeenSec: number;
  lastSeenSec: number;
  seenCount: number;
  representativeSampleId: string;
  representativeImageBlobId?: string;
  fingerprint: ScoreFingerprint;
  bestQualityScore: number;
  status: ScoreClusterStatus;
};

export type PendingScoreSample = {
  sample: RoiSample;
  fingerprint: ScoreFingerprint;
  qualityScore: number;
  imageBlobId: string;
  createdAtSec: number;
  reason: string;
  matchedClusterId?: string;
};

export type ScoreClusterUpdate = {
  decision: "same" | "maybe_same" | "different";
  sample: RoiSample;
  sampleQualityScore?: number;
  cluster?: ScoreCluster;
  resolvedPendingCluster?: ScoreCluster;
  matchedClusterId?: string;
  newClusterId?: string;
  pending?: PendingScoreSample;
  representativeSample?: RoiSample;
  previousRepresentativeImageBlobId?: string;
  discardedImageBlobIds?: string[];
  similarity?: ScoreSimilarityDebug;
  endGate?: EndGateStatus;
  endGateReason?: string;
  exported?: boolean;
  pendingEndCandidateCount?: number;
  clusters: ScoreCluster[];
  acceptedClusters: ScoreCluster[];
  pendingCount: number;
};
