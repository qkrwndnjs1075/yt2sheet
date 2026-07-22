import type { Rect } from "./layout-types";

export type ScoreRoiConfig = {
  id: string;
  videoId: string;
  url: string;
  roiRect: Rect;
  frameSize?: {
    width: number;
    height: number;
  };
  coordinateSpace: "frame";
  createdAt: string;
  sampleIntervalMs: number;
};

export type RoiSample = {
  id: string;
  sessionId: string;
  frameId: string;
  timestampSec: number;
  frameIndex: number;
  roiRect: Rect;
  image: {
    width: number;
    height: number;
    bitmapRef: ImageBitmap | HTMLCanvasElement | OffscreenCanvas;
  };
};

export type EndGateStatus =
  | "none"
  | "held"
  | "confirmed"
  | "discarded_overlay"
  | "discarded_unconfirmed";

export type RoiIdentityDebugInfo = {
  sampleId?: string;
  timestampSec?: number;
  decision?: "same" | "maybe_same" | "different";
  matchedClusterId?: string;
  newClusterId?: string;
  fullPHashDistance?: number;
  contentPHashDistance?: number;
  contentDHashDistance?: number;
  verticalProjectionSimilarity?: number;
  horizontalProjectionSimilarity?: number;
  clusterCount: number;
  acceptedClusterCount: number;
  pendingCount: number;
  representativeQualityScore?: number;
  skippedReason?: string;
  endGate?: EndGateStatus;
  endGateReason?: string;
  exported?: boolean;
  pendingEndCandidateCount?: number;
};
