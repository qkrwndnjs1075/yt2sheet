import type { CapturedScoreSystem, CaptureContext } from "../../shared/capture-types";
import type { ScoreCluster } from "../../shared/cluster-types";
import type { CapturedScoreRepository } from "./captured-score-repository";
import type { ImageBlobRepository } from "./image-blob-repository";
import { ThumbnailGenerator, type ThumbnailGeneratorLike } from "./thumbnail-generator";

export class UniqueScoreCaptureService {
  constructor(
    private readonly capturedScoreRepository: CapturedScoreRepository,
    private readonly imageBlobRepository: ImageBlobRepository,
    private readonly thumbnailGenerator: ThumbnailGeneratorLike = new ThumbnailGenerator(imageBlobRepository)
  ) {}

  async upsertAcceptedCluster(cluster: ScoreCluster, context: CaptureContext): Promise<CapturedScoreSystem> {
    if (cluster.status !== "accepted") {
      throw new Error(`Cannot capture non-accepted cluster: ${cluster.id}`);
    }

    if (!cluster.representativeImageBlobId) {
      throw new Error(`Accepted cluster has no representative image: ${cluster.id}`);
    }

    const existing = await this.capturedScoreRepository.findByClusterId(context.sessionId, cluster.id);
    const metadata = await this.imageBlobRepository.getMetadata(cluster.representativeImageBlobId);
    if (!metadata) {
      throw new Error(`Representative image metadata not found: ${cluster.representativeImageBlobId}`);
    }
    const thumbnailBlobId = await this.thumbnailGenerator.generate(cluster.representativeImageBlobId);
    const existingList = await this.capturedScoreRepository.listBySession(context.sessionId);
    const captured: CapturedScoreSystem = {
      id: existing?.id ?? `captured_score_${existingList.length + 1}`,
      sessionId: context.sessionId,
      clusterId: cluster.id,
      source: {
        videoId: context.videoId,
        url: context.url,
        firstSeenSec: cluster.firstSeenSec,
        lastSeenSec: cluster.lastSeenSec,
        seenCount: cluster.seenCount
      },
      image: {
        imageBlobId: cluster.representativeImageBlobId,
        thumbnailBlobId,
        width: metadata.width,
        height: metadata.height
      },
      fingerprint: cluster.fingerprint,
      qualityScore: cluster.bestQualityScore,
      order: existing?.order ?? existingList.length + 1
    };

    await this.capturedScoreRepository.upsert(captured);
    return captured;
  }
}
