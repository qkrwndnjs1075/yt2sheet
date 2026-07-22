import type { ScoreFingerprint } from "./fingerprint-types";

export type CapturedScoreSystem = {
  id: string;
  sessionId: string;
  clusterId: string;
  source: {
    videoId: string;
    url: string;
    firstSeenSec: number;
    lastSeenSec: number;
    seenCount?: number;
  };
  image: {
    imageBlobId: string;
    thumbnailBlobId?: string;
    width: number;
    height: number;
    dataUrl?: string;
  };
  fingerprint: ScoreFingerprint;
  qualityScore: number;
  order: number;
  occurrenceId?: string;
  occurrenceOrder?: number;
  repeatIndex?: number;
  repeatCount?: number;
  previousOccurrenceId?: string;
  nextOccurrenceId?: string;
};

export type CaptureContext = {
  sessionId: string;
  videoId: string;
  url: string;
};
