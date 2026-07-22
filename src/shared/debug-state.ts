import type { DebugScoreOccurrence, DebugUniqueScore, FrameMetaMessage } from "./messages";
import type { CaptureError, CaptureSession } from "./types";

export const DEBUG_CAPTURE_STATE_KEY = "debugCaptureState";

export type DebugCaptureState = {
  currentSession: CaptureSession | null;
  lastCompletedSession: CaptureSession | null;
  recentFrames: FrameMetaMessage[];
  uniqueScores: DebugUniqueScore[];
  exportOccurrences?: DebugScoreOccurrence[];
  exportCandidates: DebugUniqueScore[];
  lastError: CaptureError | null;
  updatedAt: string;
};
