import type { CaptureContext } from "../../shared/capture-types";
import type { RoiSample } from "../../shared/roi-types";
import type { ScoreClusterUpdate } from "../../shared/cluster-types";
import type { ImageBlobRepository } from "../capture/image-blob-repository";
import { thumbnailBlobIdFor } from "../capture/thumbnail-generator";
import { UniqueScoreCaptureService } from "../capture/unique-score-capture-service";
import { ScoreIdentityDebugLogger } from "../debug/score-identity-debug-logger";
import { ScoreClusterer } from "./score-clusterer";
import { ScoreFingerprintGenerator } from "./fingerprint-generator";
import { ScoreNormalizer } from "./score-normalizer";
import { ScoreQualityEvaluator } from "./quality-evaluator";

export type ScoreIdentityResult = ScoreClusterUpdate;
type FingerprintGeneratorLike = Pick<ScoreFingerprintGenerator, "generate">;
type NormalizedFingerprintGeneratorLike = FingerprintGeneratorLike & Partial<Pick<ScoreFingerprintGenerator, "generateFromNormalized">>;
type QualityEvaluatorLike = Pick<ScoreQualityEvaluator, "evaluate">;
type CaptureServiceLike = Pick<UniqueScoreCaptureService, "upsertAcceptedCluster">;
type DebugLoggerLike = Pick<ScoreIdentityDebugLogger, "log">;
type NormalizerLike = Pick<ScoreNormalizer, "normalize">;

export class ScoreIdentityDetector {
  constructor(
    private readonly fingerprintGenerator: NormalizedFingerprintGeneratorLike,
    private readonly qualityEvaluator: QualityEvaluatorLike,
    private readonly imageBlobRepository: ImageBlobRepository,
    private readonly clusterer: ScoreClusterer,
    private readonly captureService: CaptureServiceLike,
    private readonly debugLogger: DebugLoggerLike,
    private readonly normalizer: NormalizerLike = new ScoreNormalizer()
  ) {}

  async handleSample(sample: RoiSample, context: CaptureContext): Promise<ScoreIdentityResult> {
    const normalized = this.normalizer.normalize(sample);
    const fingerprint = this.fingerprintGenerator.generateFromNormalized
      ? this.fingerprintGenerator.generateFromNormalized(normalized, sample.image.width / Math.max(1, sample.image.height))
      : this.fingerprintGenerator.generate(sample);
    const quality = this.qualityEvaluator.evaluate(normalized);
    const imageBlobId = await this.imageBlobRepository.saveSampleImage(sample);
    const clusterResult = this.clusterer.handleFingerprint({
      sample,
      fingerprint,
      qualityScore: quality.score,
      imageBlobId
    });

    for (const cluster of [clusterResult.resolvedPendingCluster, clusterResult.cluster]) {
      if (cluster?.status === "accepted") {
        await this.captureService.upsertAcceptedCluster(cluster, context);
      }
    }

    if (clusterResult.cluster?.status === "accepted" && clusterResult.cluster.representativeImageBlobId !== imageBlobId) {
      await this.imageBlobRepository.delete(imageBlobId);
    }

    if (clusterResult.previousRepresentativeImageBlobId) {
      await this.imageBlobRepository.delete(clusterResult.previousRepresentativeImageBlobId);
      await this.imageBlobRepository.delete(thumbnailBlobIdFor(clusterResult.previousRepresentativeImageBlobId));
    }

    for (const discardedImageBlobId of clusterResult.discardedImageBlobIds ?? []) {
      if (discardedImageBlobId !== clusterResult.cluster?.representativeImageBlobId) {
        await this.imageBlobRepository.delete(discardedImageBlobId);
      }
    }

    this.debugLogger.log({
      sample,
      quality,
      clusterResult
    });

    return clusterResult;
  }
}
