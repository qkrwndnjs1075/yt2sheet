import type { ScoreRoiConfig } from "./roi-types";

export const DEFAULT_SAMPLE_INTERVAL_MS = 1000;

export type CaptureState =
  | "idle"
  | "starting"
  | "running"
  | "paused"
  | "stopping"
  | "stopped"
  | "completed"
  | "error";

export type VideoSourceInfo = {
  platform: "youtube";
  url: string;
  videoId: string;
  title: string;
  durationSec: number | null;
  currentTimeSec: number;
  playbackRate: number;
  paused: boolean;
  videoRect?: VideoElementRect;
  viewport?: ViewportInfo;
};

export type VideoElementRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type ViewportInfo = {
  width: number;
  height: number;
  devicePixelRatio: number;
};

export type CaptureSession = {
  id: string;
  tabId: number;
  source: VideoSourceInfo;
  config: {
    sampleIntervalMs: number;
    startTimeSec: number;
    endTimeSec: number | null;
    captureVideoOnly: true;
    persistRawFrames: false;
    roiConfig?: ScoreRoiConfig;
  };
  state: CaptureState;
  stats: {
    framesSampled: number;
    framesDropped: number;
    startedAt: string;
    endedAt?: string;
    lastTimestampSec?: number;
    lastFrameWidth?: number;
    lastFrameHeight?: number;
  };
};

export type InputFrame = {
  id: string;
  sessionId: string;
  source: {
    platform: "youtube";
    videoId: string;
    url: string;
    title: string;
  };
  timing: {
    timestampSec: number;
    sampledAt: string;
    frameIndex: number;
    playbackRate: number;
  };
  image: {
    width: number;
    height: number;
  };
  meta: {
    sampleIntervalMs: number;
    tabId: number;
    devicePixelRatio?: number;
    videoRect?: VideoElementRect;
    viewport?: ViewportInfo;
    roiConfig?: ScoreRoiConfig;
    durationSec?: number | null;
    nearEnd?: boolean;
    videoEnded?: boolean;
  };
};

export type CaptureErrorCode =
  | "NOT_YOUTUBE_WATCH_PAGE"
  | "NO_ACTIVE_TAB"
  | "VIDEO_ELEMENT_NOT_FOUND"
  | "TAB_CAPTURE_DENIED"
  | "OFFSCREEN_CREATE_FAILED"
  | "GET_USER_MEDIA_FAILED"
  | "VIDEO_STREAM_ENDED"
  | "SAMPLING_LOOP_ERROR"
  | "TIMESTAMP_SYNC_LOST"
  | "SESSION_NOT_FOUND"
  | "ROI_SELECTION_CANCELLED"
  | "UNKNOWN";

export type CaptureError = {
  code: CaptureErrorCode;
  message: string;
  sessionId?: string;
  cause?: string;
};
