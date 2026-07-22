import type { ScoreCluster } from "../../shared/cluster-types";
import type { CapturedScoreSystem } from "../../shared/capture-types";
import type { ScoreRoiConfig } from "../../shared/roi-types";
import { packScorePages } from "../../shared/score-page-layout";

export type RepresentativeScoreImage = {
  imageBlobId: string;
  thumbnailBlobId?: string;
  width: number;
  height: number;
  dataUrl?: string;
};

export class UniqueScoreCandidateBuilder {
  build(
    clusters: ScoreCluster[],
    source: Pick<ScoreRoiConfig, "videoId" | "url">,
    representativeImages: ReadonlyMap<string, RepresentativeScoreImage>
  ): CapturedScoreSystem[] {
    return clusters
      .filter((cluster) => cluster.status === "accepted")
      .sort((a, b) => a.firstSeenSec - b.firstSeenSec)
      .flatMap((cluster) => {
        const imageBlobId = cluster.representativeImageBlobId ?? cluster.representativeSampleId;
        const image = representativeImages.get(imageBlobId);

        return image
          ? [{
              id: "",
              sessionId: cluster.sessionId,
              clusterId: cluster.id,
              source: {
                videoId: source.videoId,
                url: source.url,
                firstSeenSec: cluster.firstSeenSec,
                lastSeenSec: cluster.lastSeenSec,
                seenCount: cluster.seenCount
              },
              image,
              fingerprint: cluster.fingerprint,
              qualityScore: cluster.bestQualityScore,
              order: 0
            }]
          : [];
      })
      .map((system, index) => ({
        ...system,
        id: `captured_score_${index + 1}`,
        order: index + 1
      }));
  }

  chunkPages(systems: CapturedScoreSystem[]): CapturedScoreSystem[][] {
    return packScorePages(systems);
  }
}
