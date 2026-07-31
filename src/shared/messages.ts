import type { CapturedScoreSystem } from "./capture-types";
import type { CaptureError, CaptureSession, VideoElementRect, VideoSourceInfo, ViewportInfo } from "./types";
import type { FrameLayoutSummary } from "./layout-types";
import type { RoiIdentityDebugInfo, ScoreRoiConfig } from "./roi-types";
import type { ScorePageLayoutConfig } from "./score-page-layout";

export type DebugUniqueScore = Omit<CapturedScoreSystem, "fingerprint">;

export type DebugScoreOccurrence = DebugUniqueScore & {
  readonly occurrenceId: string;
  readonly occurrenceOrder: number;
};

export type FrameMetaMessage = {
  type: "FRAME_SAMPLED";
  sessionId: string;
  frameIndex: number;
  timestampSec: number;
  width: number;
  height: number;
  sampledAt: string;
  previewDataUrl?: string;
  previewWidth?: number;
  previewHeight?: number;
  layout?: FrameLayoutSummary;
  roi?: {
    rect: ScoreRoiConfig["roiRect"];
    sampleId?: string;
    width: number;
    height: number;
  };
  identity?: RoiIdentityDebugInfo;
  uniqueScores?: DebugUniqueScore[];
  exportOccurrences?: DebugScoreOccurrence[];
  exportCandidates?: DebugUniqueScore[];
};

export type VideoProbeTick = {
  type: "VIDEO_PROBE_TICK";
  sessionId: string;
  tabId: number;
  videoId: string;
  currentTimeSec: number;
  durationSec: number | null;
  paused: boolean;
  playbackRate: number;
  videoRect?: VideoElementRect;
  viewport?: ViewportInfo;
  wallClockAt: string;
};

export type RuntimeMessage =
  | { type: "GET_VIDEO_SOURCE_INFO" }
  | { type: "GET_DEBUG_CAPTURE_STATE" }
  | { type: "GET_EXPORT_REVIEW_DATA"; sessionId: string }
  | { type: "VALIDATE_EXPORT_REVIEW"; sessionId: string; occurrenceOrder?: string[]; scoreOrder?: string[] }
  | { type: "PREVIEW_SCORE_EXPORT"; sessionId: string; occurrenceOrder?: string[]; scoreOrder?: string[] }
  | { type: "SELECT_SCORE_ROI"; videoId: string; url: string; sampleIntervalMs: number }
  | { type: "SCORE_EXPORT_READY"; sessionId: string; videoTitle: string; scoreCount: number; pageCount: number; pageLayout: ScorePageLayoutConfig }
  | { type: "EXPORT_SCORE_CAPTURE"; sessionId: string; format: "pdf" | "png"; pages: PreviewScoreExportPage[] }
  | { type: "START_VIDEO_PROBE"; sessionId: string; tabId: number; sampleIntervalMs: number }
  | { type: "STOP_VIDEO_PROBE"; sessionId: string }
  | { type: "START_CAPTURE"; session: CaptureSession; streamId: string }
  | { type: "STOP_CAPTURE"; sessionId: string; reason: "stopped" | "completed" | "error" }
  | VideoProbeTick
  | { type: "VIDEO_TIMING_UPDATE"; tick: VideoProbeTick }
  | { type: "VIDEO_ENDED"; sessionId: string; tabId: number; videoId: string; wallClockAt: string }
  | FrameMetaMessage
  | { type: "CAPTURE_STARTED"; sessionId: string }
  | { type: "CAPTURE_STOPPED"; sessionId: string; reason: "stopped" | "completed" | "error" }
  | { type: "CAPTURE_ERROR"; error: CaptureError };

export type GetVideoSourceInfoResponse =
  | { ok: true; source: VideoSourceInfo }
  | { ok: false; error: CaptureError };

export type CaptureCommandResponse =
  | { ok: true }
  | { ok: false; error: CaptureError };

export type SelectScoreRoiResponse =
  | { ok: true; roiConfig: ScoreRoiConfig }
  | { ok: false; error: CaptureError };

export type ExportScoreCaptureResponse =
  | { ok: true; downloadCount: number; validation?: ExportValidationSummary; validationDetails?: ExportValidationDetail[] }
  | { ok: false; error: CaptureError };

export type ExportReviewDataResponse =
  | { ok: true; scores: DebugUniqueScore[]; exportOccurrences?: DebugScoreOccurrence[]; exportCandidates?: DebugUniqueScore[] }
  | { ok: false; error: CaptureError };

export type ExportReviewValidationResponse =
  | { ok: true; validation: ExportValidationSummary; validationDetails: ExportValidationDetail[] }
  | { ok: false; error: CaptureError };

export type PreviewScoreExportPage = {
  readonly pageIndex: number;
  readonly dataUrl: string;
};

export type PreviewScoreExportResponse =
  | {
      ok: true;
      validation: ExportValidationSummary;
      validationDetails: ExportValidationDetail[];
      pageCount: number;
      pages: PreviewScoreExportPage[];
    }
  | { ok: false; error: CaptureError };

export type ExportValidationSummary = {
  keptCount: number;
  replacedCount: number;
  excludedCount: number;
  notes: string[];
};

export type ExportValidationDetail = {
  clusterId: string;
  scoreId: string;
  occurrenceId?: string;
  occurrenceOrder?: number;
  action: "kept" | "replaced" | "excluded";
  reason: string;
  replacementScoreId?: string;
  validator: "local";
};
