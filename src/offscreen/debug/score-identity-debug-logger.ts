import { logger } from "../../shared/logger";
import type { RoiSample } from "../../shared/roi-types";
import type { ScoreClusterUpdate } from "../../shared/cluster-types";
import type { ScoreImageQuality } from "../identity/quality-evaluator";

export type ScoreIdentityDebugLog = {
  sessionId: string;
  sampleId: string;
  timestampSec: number;
  resultType: "same" | "new" | "pending";
  decision: ScoreClusterUpdate["decision"];
  activeClusterId?: string;
  matchedClusterId?: string;
  newClusterId?: string;
  metrics?: ScoreClusterUpdate["similarity"];
  qualityScore: number;
  representativeQualityScore?: number;
  clusterCount: number;
  acceptedClusterCount: number;
  pendingCount: number;
};

export class ScoreIdentityDebugLogger {
  log(input: { sample: RoiSample; quality: ScoreImageQuality; clusterResult: ScoreClusterUpdate }): ScoreIdentityDebugLog {
    const { sample, quality, clusterResult } = input;
    const log: ScoreIdentityDebugLog = {
      sessionId: sample.sessionId,
      sampleId: sample.id,
      timestampSec: sample.timestampSec,
      resultType: clusterResult.decision === "different" ? "new" : clusterResult.decision === "maybe_same" ? "pending" : "same",
      decision: clusterResult.decision,
      activeClusterId: clusterResult.cluster?.id,
      matchedClusterId: clusterResult.matchedClusterId,
      newClusterId: clusterResult.newClusterId,
      metrics: clusterResult.similarity,
      qualityScore: quality.score,
      representativeQualityScore: clusterResult.cluster?.bestQualityScore,
      clusterCount: clusterResult.clusters.length,
      acceptedClusterCount: clusterResult.acceptedClusters.length,
      pendingCount: clusterResult.pendingCount
    };

    logger.debug("[ROI Identity]", log);
    return log;
  }
}
