import { logger } from "../shared/logger";
import type { RoiIdentityDebugInfo, RoiSample, ScoreRoiConfig } from "../shared/roi-types";
import type { CaptureCommandResponse, DebugScoreOccurrence, DebugUniqueScore, FrameMetaMessage, RuntimeMessage } from "../shared/messages";
import type { CaptureError, CaptureSession } from "../shared/types";
import type { FrameSink, OffscreenInputFrame } from "./frame-sink";
import type { ScoreClusterUpdate } from "../shared/cluster-types";
import { type RepresentativeScoreImage, UniqueScoreCandidateBuilder } from "./capture/unique-score-candidate-builder";
import { EndCandidateGate } from "./identity/end-candidate-gate";
import { FingerprintGenerator } from "./identity/fingerprint-generator";
import { QualityEvaluator } from "./identity/quality-evaluator";
import { ScoreClusterer } from "./identity/score-clusterer";
import { ScoreNormalizer } from "./identity/score-normalizer";
import { RoiSampler } from "./roi/roi-sampler";

const MAX_RECENT_META = 3;
const PREVIEW_MAX_EDGE_PX = 360;
const PREVIEW_JPEG_QUALITY = 0.65;
const MAX_EXPORT_CANDIDATES_PER_CLUSTER = 4;

type ExportCandidateImage = RepresentativeScoreImage & {
  dataUrl: string;
  firstSeenSec: number;
  lastSeenSec: number;
  qualityScore: number;
};

type ExportOccurrenceState = {
  readonly occurrenceId: string;
  readonly clusterId: string;
  readonly firstSeenSec: number;
  readonly lastSeenSec: number;
  readonly seenCount: number;
  readonly order: number;
};

export type DebugExportOccurrenceInput = {
  readonly id: string;
  readonly sessionId?: string;
  readonly clusterId: string;
  readonly firstSeenSec: number;
  readonly lastSeenSec: number;
  readonly seenCount: number;
  readonly order: number;
  readonly imageDataUrl: string;
  readonly imageBlobId?: string;
  readonly thumbnailBlobId?: string;
  readonly width: number;
  readonly height: number;
  readonly qualityScore?: number;
  readonly videoId?: string;
  readonly url?: string;
};

export function buildExportOccurrencesForDebug(scores: readonly DebugExportOccurrenceInput[]): DebugScoreOccurrence[] {
  let occurrences: DebugScoreOccurrence[] = [];

  for (const score of scores) {
    const lastOccurrence = occurrences.at(-1);
    if (lastOccurrence?.clusterId === score.clusterId) {
      occurrences = [
        ...occurrences.slice(0, -1),
        {
          ...lastOccurrence,
          source: {
            ...lastOccurrence.source,
            lastSeenSec: score.lastSeenSec,
            seenCount: (lastOccurrence.source.seenCount ?? 0) + score.seenCount
          }
        }
      ];
      continue;
    }

    const occurrenceOrder = occurrences.length + 1;
    const occurrenceId = `captured_score_occurrence_${occurrenceOrder}`;
    occurrences = [
      ...occurrences,
      {
        id: occurrenceId,
        occurrenceId,
        occurrenceOrder,
        sessionId: score.sessionId ?? "",
        clusterId: score.clusterId,
        source: {
          videoId: score.videoId ?? "",
          url: score.url ?? "",
          firstSeenSec: score.firstSeenSec,
          lastSeenSec: score.lastSeenSec,
          seenCount: score.seenCount
        },
        image: {
          imageBlobId: score.imageBlobId ?? score.id,
          ...(score.thumbnailBlobId ? { thumbnailBlobId: score.thumbnailBlobId } : {}),
          width: score.width,
          height: score.height,
          dataUrl: score.imageDataUrl
        },
        qualityScore: score.qualityScore ?? 0,
        order: occurrenceOrder
      }
    ];
  }

  return occurrences;
}

export class DebugFrameSink implements FrameSink {
  private recentFrameMeta: FrameMetaMessage[] = [];
  private readonly roiSampler = new RoiSampler();
  private readonly normalizer = new ScoreNormalizer();
  private readonly fingerprintGenerator = new FingerprintGenerator();
  private readonly qualityEvaluator = new QualityEvaluator();
  private readonly clusterer = new ScoreClusterer();
  private readonly endCandidateGate = new EndCandidateGate(this.clusterer);
  private readonly uniqueScoreBuilder = new UniqueScoreCandidateBuilder();
  private readonly representativeImages = new Map<string, RepresentativeScoreImage & { dataUrl: string }>();
  private readonly exportCandidatesByClusterId = new Map<string, ExportCandidateImage[]>();
  private readonly deliveredImageBlobIds = new Set<string>();
  private exportOccurrenceStates: ExportOccurrenceState[] = [];
  private nextOccurrenceNumber = 1;

  async onFrame(frame: OffscreenInputFrame): Promise<void> {
    const roiConfig = frame.meta.roiConfig;
    const sample = roiConfig ? this.roiSampler.sample(frame, roiConfig) : null;
    const clusterUpdate = sample ? this.processRoiSample(sample, frame.meta.nearEnd === true, frame.meta.videoEnded === true) : null;
    if (clusterUpdate) {
      this.storeRepresentativeImage(clusterUpdate);
      this.recordExportOccurrence(clusterUpdate);
    }
    const uniqueScores = roiConfig ? this.buildDebugUniqueScores(roiConfig) : undefined;
    const exportOccurrences = roiConfig ? this.buildDebugExportOccurrences(roiConfig) : undefined;
    const exportCandidates = roiConfig ? this.buildDebugExportCandidates(roiConfig) : undefined;
    const meta: FrameMetaMessage = {
      type: "FRAME_SAMPLED",
      sessionId: frame.sessionId,
      frameIndex: frame.timing.frameIndex,
      timestampSec: frame.timing.timestampSec,
      width: frame.image.width,
      height: frame.image.height,
      sampledAt: frame.timing.sampledAt,
      ...(sample
        ? {
            roi: {
              rect: sample.roiRect,
              sampleId: sample.id,
              width: sample.image.width,
              height: sample.image.height
            },
            identity: toIdentityDebug(clusterUpdate),
            uniqueScores,
            exportOccurrences,
            exportCandidates,
            ...createRoiPreview(sample)
          }
        : {
            identity: {
              clusterCount: this.clusterer.getClusters().length,
              acceptedClusterCount: this.clusterer.getAcceptedClusters().length,
              pendingCount: this.clusterer.getPendingCount(),
              skippedReason: "ROI_NOT_CONFIGURED"
            }
          })
    };

    const outbound = this.prepareFrameForTransport(meta);
    this.recentFrameMeta = [...this.recentFrameMeta, outbound.message].slice(-MAX_RECENT_META);
    logger.debug(`[ROI Identity] ${summarizeIdentity(meta.identity)}`);
    const response = await chrome.runtime.sendMessage<RuntimeMessage, CaptureCommandResponse>(outbound.message);
    if (!response?.ok) {
      throw response?.error ?? new Error("Background frame persistence was not acknowledged.");
    }
    outbound.imageBlobIds.forEach((imageBlobId) => this.deliveredImageBlobIds.add(imageBlobId));
  }

  async onSessionStarted(session: CaptureSession): Promise<void> {
    this.recentFrameMeta = [];
    this.clusterer.reset();
    this.endCandidateGate.reset();
    this.representativeImages.clear();
    this.exportCandidatesByClusterId.clear();
    this.deliveredImageBlobIds.clear();
    this.exportOccurrenceStates = [];
    this.nextOccurrenceNumber = 1;
    logger.info("Session started", {
      videoId: session.source.videoId,
      title: session.source.title,
      startTimeSec: session.config.startTimeSec,
      sampleIntervalMs: session.config.sampleIntervalMs,
      roiRect: session.config.roiConfig?.roiRect
    });
    await chrome.runtime.sendMessage<RuntimeMessage>({ type: "CAPTURE_STARTED", sessionId: session.id });
  }

  async onSessionStopped(session: CaptureSession): Promise<void> {
    const flushedEndCandidate = this.endCandidateGate.flushUnconfirmed();
    const capturedSystems = session.config.roiConfig
      ? this.uniqueScoreBuilder.build(this.clusterer.getAcceptedClusters(), session.config.roiConfig, this.representativeImages)
      : [];
    const pages = this.uniqueScoreBuilder.chunkPages(capturedSystems);
    logger.info("Session stopped", {
      framesSampled: session.stats.framesSampled,
      framesDropped: session.stats.framesDropped,
      lastTimestampSec: session.stats.lastTimestampSec,
      uniqueScoreCount: capturedSystems.length,
      representativeImageCount: this.representativeImages.size,
      flushedEndCandidate: flushedEndCandidate ? toIdentityDebug(flushedEndCandidate) : undefined,
      pages: pages.map((page) => page.map((system) => system.clusterId)),
      recentFrameMeta: this.recentFrameMeta
    });
  }

  async onError(error: CaptureError): Promise<void> {
    logger.error(error);
    await chrome.runtime.sendMessage<RuntimeMessage>({ type: "CAPTURE_ERROR", error });
  }

  private processRoiSample(sample: RoiSample, nearEnd: boolean, videoEnded: boolean): ScoreClusterUpdate {
    const normalized = this.normalizer.normalize(sample);
    const fingerprint = this.fingerprintGenerator.generate(normalized, sample.image.width / Math.max(1, sample.image.height));
    const qualityScore = this.qualityEvaluator.score(normalized);
    const update = this.endCandidateGate.handle({
      sample,
      fingerprint,
      qualityScore,
      imageBlobId: `roi-representative:${sample.id}`,
      normalized,
      nearEnd,
      videoEnded
    });
    return { ...update, sampleQualityScore: qualityScore };
  }

  private storeRepresentativeImage(update: ScoreClusterUpdate): void {
    const sample = update.representativeSample ?? update.sample;
    const cluster = update.cluster;
    const blobId = `roi-representative:${sample.id}`;

    if (update.exported === false || !cluster) {
      return;
    }

    const image = createRoiExportImage(sample);
    const storedImage = {
      imageBlobId: blobId,
      thumbnailBlobId: `roi-thumbnail:${sample.id}`,
      dataUrl: image.dataUrl,
      width: image.width,
      height: image.height,
      firstSeenSec: sample.timestampSec,
      lastSeenSec: sample.timestampSec,
      qualityScore: sample.id === update.sample.id
        ? update.sampleQualityScore ?? cluster.bestQualityScore
        : cluster.bestQualityScore
    };

    this.representativeImages.set(blobId, storedImage);
    this.rememberExportCandidate(cluster.id, storedImage);
  }

  private buildDebugUniqueScores(source: Pick<ScoreRoiConfig, "videoId" | "url">): DebugUniqueScore[] {
    return this.uniqueScoreBuilder
      .build(this.clusterer.getAcceptedClusters(), source, this.representativeImages)
      .map(({ fingerprint: _fingerprint, ...score }) => score);
  }

  private rememberExportCandidate(clusterId: string, image: ExportCandidateImage): void {
    const existing = this.exportCandidatesByClusterId.get(clusterId) ?? [];
    const next = [...existing.filter((item) => item.imageBlobId !== image.imageBlobId), image]
      .sort((a, b) => b.qualityScore - a.qualityScore)
      .slice(0, MAX_EXPORT_CANDIDATES_PER_CLUSTER);
    this.exportCandidatesByClusterId.set(clusterId, next);
  }

  private recordExportOccurrence(update: ScoreClusterUpdate): void {
    const cluster = update.cluster;
    if (update.exported === false || !cluster) {
      return;
    }

    const lastOccurrence = this.exportOccurrenceStates.at(-1);
    if (lastOccurrence?.clusterId === cluster.id) {
      this.exportOccurrenceStates = [
        ...this.exportOccurrenceStates.slice(0, -1),
        {
          ...lastOccurrence,
          lastSeenSec: update.sample.timestampSec,
          seenCount: lastOccurrence.seenCount + 1
        }
      ];
      return;
    }

    const occurrenceOrder = this.nextOccurrenceNumber;
    this.exportOccurrenceStates = [
      ...this.exportOccurrenceStates,
      {
        occurrenceId: `captured_score_occurrence_${occurrenceOrder}`,
        clusterId: cluster.id,
        firstSeenSec: update.newClusterId === cluster.id ? cluster.firstSeenSec : update.sample.timestampSec,
        lastSeenSec: update.sample.timestampSec,
        seenCount: update.newClusterId === cluster.id ? cluster.seenCount : 1,
        order: occurrenceOrder
      }
    ];
    this.nextOccurrenceNumber += 1;
  }

  private buildDebugExportOccurrences(source: Pick<ScoreRoiConfig, "videoId" | "url">): DebugScoreOccurrence[] {
    const clustersById = new Map(this.clusterer.getAcceptedClusters().map((cluster) => [cluster.id, cluster]));
    const scores: DebugExportOccurrenceInput[] = [];

    for (const occurrence of this.exportOccurrenceStates) {
      const cluster = clustersById.get(occurrence.clusterId);
      if (!cluster) {
        continue;
      }

      const imageBlobId = cluster.representativeImageBlobId ?? cluster.representativeSampleId;
      const image = this.representativeImages.get(imageBlobId);
      if (!image) {
        continue;
      }

      scores.push({
        id: occurrence.occurrenceId,
        sessionId: cluster.sessionId,
        clusterId: cluster.id,
        firstSeenSec: occurrence.firstSeenSec,
        lastSeenSec: occurrence.lastSeenSec,
        seenCount: occurrence.seenCount,
        order: occurrence.order,
        imageDataUrl: image.dataUrl,
        imageBlobId: image.imageBlobId,
        thumbnailBlobId: image.thumbnailBlobId,
        width: image.width,
        height: image.height,
        qualityScore: cluster.bestQualityScore,
        videoId: source.videoId,
        url: source.url
      });
    }

    return buildExportOccurrencesForDebug(scores);
  }

  private buildDebugExportCandidates(source: Pick<ScoreRoiConfig, "videoId" | "url">): DebugUniqueScore[] {
    const scores: DebugUniqueScore[] = [];
    const clusters = this.clusterer.getAcceptedClusters().sort((a, b) => a.firstSeenSec - b.firstSeenSec);

    for (const cluster of clusters) {
      const images = this.exportCandidatesByClusterId.get(cluster.id) ?? [];
      images.forEach((image, imageIndex) => {
        scores.push({
          id: `captured_score_${scores.length + 1}_candidate_${imageIndex + 1}`,
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
          qualityScore: image.qualityScore,
          order: scores.length + 1
        });
      });
    }

    return scores;
  }

  private prepareFrameForTransport(meta: FrameMetaMessage): {
    message: FrameMetaMessage;
    imageBlobIds: string[];
  } {
    const newImageBlobIds = new Set<string>();
    const prepareScore = <T extends DebugUniqueScore | DebugScoreOccurrence>(score: T): T => {
      const imageBlobId = score.image.imageBlobId;
      const shouldIncludeData = !this.deliveredImageBlobIds.has(imageBlobId) && !newImageBlobIds.has(imageBlobId);
      if (shouldIncludeData && score.image.dataUrl) {
        newImageBlobIds.add(imageBlobId);
        return score;
      }

      const { dataUrl: _dataUrl, ...image } = score.image;
      return { ...score, image };
    };

    return {
      message: {
        ...meta,
        ...(meta.uniqueScores ? { uniqueScores: meta.uniqueScores.map(prepareScore) } : {}),
        ...(meta.exportOccurrences ? { exportOccurrences: meta.exportOccurrences.map(prepareScore) } : {}),
        ...(meta.exportCandidates ? { exportCandidates: meta.exportCandidates.map(prepareScore) } : {})
      },
      imageBlobIds: [...newImageBlobIds]
    };
  }
}

function toIdentityDebug(update: ScoreClusterUpdate | null): RoiIdentityDebugInfo {
  if (!update) {
    return {
      clusterCount: 0,
      acceptedClusterCount: 0,
      pendingCount: 0,
      skippedReason: "ROI_NOT_CONFIGURED"
    };
  }

  return {
    sampleId: update.sample.id,
    timestampSec: update.sample.timestampSec,
    decision: update.decision,
    matchedClusterId: update.matchedClusterId,
    newClusterId: update.newClusterId,
    fullPHashDistance: update.similarity?.fullPHashDistance,
    contentPHashDistance: update.similarity?.contentPHashDistance,
    contentDHashDistance: update.similarity?.contentDHashDistance,
    verticalProjectionSimilarity: update.similarity?.verticalProjectionSimilarity,
    horizontalProjectionSimilarity: update.similarity?.horizontalProjectionSimilarity,
    clusterCount: update.clusters.length,
    acceptedClusterCount: update.acceptedClusters.length,
    pendingCount: update.pendingCount,
    representativeQualityScore: update.cluster?.bestQualityScore ?? update.pending?.qualityScore,
    endGate: update.endGate,
    endGateReason: update.endGateReason,
    exported: update.exported,
    pendingEndCandidateCount: update.pendingEndCandidateCount
  };
}

function createRoiPreview(sample: RoiSample): Pick<FrameMetaMessage, "previewDataUrl" | "previewWidth" | "previewHeight"> {
  const scale = Math.min(1, PREVIEW_MAX_EDGE_PX / Math.max(sample.image.width, sample.image.height));
  const previewWidth = Math.max(1, Math.round(sample.image.width * scale));
  const previewHeight = Math.max(1, Math.round(sample.image.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = previewWidth;
  canvas.height = previewHeight;
  canvas.getContext("2d")?.drawImage(sample.image.bitmapRef, 0, 0, previewWidth, previewHeight);

  return {
    previewDataUrl: canvas.toDataURL("image/jpeg", PREVIEW_JPEG_QUALITY),
    previewWidth,
    previewHeight
  };
}

export function createRoiExportImage(sample: RoiSample): { dataUrl: string; width: number; height: number } {
  const canvas = document.createElement("canvas");
  canvas.width = sample.image.width;
  canvas.height = sample.image.height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Unable to create ROI export canvas context.");
  }
  context.fillStyle = "#fff";
  context.fillRect(0, 0, sample.image.width, sample.image.height);
  context.drawImage(sample.image.bitmapRef, 0, 0);

  return {
    dataUrl: canvas.toDataURL("image/png"),
    width: sample.image.width,
    height: sample.image.height
  };
}

function summarizeIdentity(identity: RoiIdentityDebugInfo | undefined): string {
  if (!identity || identity.skippedReason) {
    return `skipped=${identity?.skippedReason ?? "unknown"}`;
  }

  return [
    `t=${identity.timestampSec?.toFixed(2)}s`,
    `decision=${identity.decision}`,
    `matchedCluster=${identity.matchedClusterId ?? "-"}`,
    `newCluster=${identity.newClusterId ?? "-"}`,
    `contentPHashDist=${formatNumber(identity.contentPHashDistance)}`,
    `contentDHashDist=${formatNumber(identity.contentDHashDistance)}`,
    `verticalSim=${formatNumber(identity.verticalProjectionSimilarity)}`,
    `horizontalSim=${formatNumber(identity.horizontalProjectionSimilarity)}`,
    `clusters=${identity.clusterCount}`,
    `accepted=${identity.acceptedClusterCount}`,
    `pending=${identity.pendingCount}`,
    `endGate=${identity.endGate ?? "-"}`,
    `exported=${identity.exported ?? "-"}`,
    `quality=${formatNumber(identity.representativeQualityScore)}`
  ].join(" ");
}

function formatNumber(value: number | undefined): string {
  return value === undefined ? "-" : value.toFixed(2);
}
