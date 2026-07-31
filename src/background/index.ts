// allow: SIZE_OK - inherited service-worker orchestration seam; accepted debt for a future focused refactor.
import { captureError, toErrorMessage } from "../shared/errors";
import { DEBUG_CAPTURE_STATE_KEY, type DebugCaptureState } from "../shared/debug-state";
import { logger } from "../shared/logger";
import type { CaptureCommandResponse, DebugUniqueScore, ExportReviewDataResponse, ExportReviewValidationResponse, ExportScoreCaptureResponse, ExportValidationDetail, FrameMetaMessage, GetVideoSourceInfoResponse, PreviewScoreExportResponse, RuntimeMessage, SelectScoreRoiResponse } from "../shared/messages";
import { packScorePages } from "../shared/score-page-layout";
import { SCORE_IDENTITY_CONFIG } from "../shared/score-identity-config";
import { DEFAULT_SAMPLE_INTERVAL_MS, type CaptureError, type CaptureSession } from "../shared/types";
import { isYouTubeWatchUrl } from "../shared/youtube";
import { OffscreenManager } from "./offscreen-manager";
import { CaptureImageStorage } from "./capture-image-storage";
import { blobToDataUrl, exportApprovedPreviewAsPdf, exportScoresAsPngPages, previewPageBlobs, safeFileBaseName, type ScoreExportOptions } from "./score-export-download";
import { validateExportScores } from "./export-score-validator";
import { SessionManager } from "./session-manager";
import { getTabMediaStreamId } from "./tab-capture";

const sessionManager = new SessionManager();
const offscreenManager = new OffscreenManager();
const captureImageStorage = new CaptureImageStorage();
const MAX_DEBUG_FRAMES = 20;
const MAX_DEBUG_PREVIEWS = 3;
const STALE_TRANSITION_SESSION_MS = 60_000;
type BackgroundCaptureEvent = Extract<RuntimeMessage, { type: "FRAME_SAMPLED" | "CAPTURE_STOPPED" }>;
let captureMessageQueue: Promise<void> = Promise.resolve();

chrome.action.onClicked.addListener((tab) => {
  void handleActionClick(tab);
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (message.type === "GET_DEBUG_CAPTURE_STATE") {
    void readDebugState().then(sendResponse);
    return true;
  }

  if (message.type === "GET_EXPORT_REVIEW_DATA") {
    void getExportReviewData(message).then(sendResponse);
    return true;
  }

  if (message.type === "VALIDATE_EXPORT_REVIEW") {
    void validateExportReview(message).then(sendResponse);
    return true;
  }

  if (message.type === "PREVIEW_SCORE_EXPORT") {
    void previewScoreExport(message).then(sendResponse);
    return true;
  }

  if (message.type === "EXPORT_SCORE_CAPTURE") {
    void exportScoreCapture(message).then(sendResponse);
    return true;
  }

  if (isBackgroundCaptureEvent(message)) {
    void enqueueCaptureMessage(message).then(sendResponse);
    return true;
  }

  void handleRuntimeMessage(message);
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void stopSessionForTab(tabId, "stopped");
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    void stopSessionForTab(tabId, "stopped");
  }
});

async function handleActionClick(tab: chrome.tabs.Tab): Promise<void> {
  try {
    const current = await sessionManager.getCurrentSession();

    if (current && isActiveSessionState(current)) {
      if (isRecoverableStaleSession(current)) {
        logger.warn("Clearing stale transitional session before starting a new capture.", {
          sessionId: current.id,
          state: current.state,
          startedAt: current.stats.startedAt
        });
        await sessionManager.clear(current.id);
        await startSession(tab);
        return;
      }

      if (tab.id !== current.tabId || !isYouTubeWatchUrl(tab.url)) {
        logger.warn("Capture is already running in another YouTube watch tab.", { tabId: current.tabId });
        return;
      }

      await stopSession(current, "stopped");
      return;
    }

    await startSession(tab);
  } catch (error) {
    const normalized = normalizeCaptureError(error);
    if (normalized.code === "ROI_SELECTION_CANCELLED") {
      logger.info("ROI selection cancelled.");
      return;
    }

    await recordDebugError(normalized);
    logger.error("Action click failed", toErrorMessage(normalized));
  }
}

async function startSession(tab: chrome.tabs.Tab): Promise<void> {
  if (!tab.id) {
    throw captureError("NO_ACTIVE_TAB", "No active tab is available.");
  }

  if (!isYouTubeWatchUrl(tab.url)) {
    throw captureError("NOT_YOUTUBE_WATCH_PAGE", "Open a YouTube watch page before starting frame collection.");
  }

  const streamId = await getTabMediaStreamId(tab.id);

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["src/content/video-probe.js"]
  });
  await chrome.scripting.insertCSS({
    target: { tabId: tab.id },
    files: ["src/content/roi-selector.css"]
  });
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["src/content/roi-selector.js"]
  });

  const response = await chrome.tabs.sendMessage<RuntimeMessage, GetVideoSourceInfoResponse>(tab.id, { type: "GET_VIDEO_SOURCE_INFO" });

  if (!response?.ok) {
    throw response?.error ?? captureError("VIDEO_ELEMENT_NOT_FOUND", "Unable to read video state from the active YouTube tab.");
  }

  const roiConfig = await selectScoreRoi(tab.id, response.source.videoId, response.source.url);
  const session = await sessionManager.start(tab.id, response.source, roiConfig);
  await recordDebugSession(session);
  logger.info("Session starting", {
    videoId: session.source.videoId,
    title: session.source.title,
    startTimeSec: session.config.startTimeSec,
    sampleIntervalMs: session.config.sampleIntervalMs
  });

  try {
    await offscreenManager.ensureDocument();
    await startOffscreenCapture(tab.id, session, streamId);

    await chrome.tabs.sendMessage<RuntimeMessage>(tab.id, {
      type: "START_VIDEO_PROBE",
      sessionId: session.id,
      tabId: tab.id,
      sampleIntervalMs: session.config.sampleIntervalMs
    });

    const runningSession = await sessionManager.setState(session.id, "running");
    if (runningSession) {
      await recordDebugSession(runningSession);
    }
  } catch (error) {
    await failSessionStartup(session, error);
    throw error;
  }
}

async function selectScoreRoi(tabId: number, videoId: string, url: string): Promise<NonNullable<CaptureSession["config"]["roiConfig"]>> {
  const response = await chrome.tabs.sendMessage<RuntimeMessage, SelectScoreRoiResponse>(tabId, {
    type: "SELECT_SCORE_ROI",
    videoId,
    url,
    sampleIntervalMs: DEFAULT_SAMPLE_INTERVAL_MS
  });

  if (!response?.ok) {
    throw response?.error ?? captureError("ROI_SELECTION_CANCELLED", "Score ROI selection was cancelled.");
  }

  return response.roiConfig;
}

async function startOffscreenCapture(tabId: number, session: CaptureSession, initialStreamId: string): Promise<void> {
  const firstResponse = await sendStartCapture(session, initialStreamId);
  if (firstResponse.ok) {
    return;
  }

  const firstError = firstResponse.error ?? captureError("GET_USER_MEDIA_FAILED", "Offscreen capture did not start.", undefined, session.id);
  if (firstError.code !== "GET_USER_MEDIA_FAILED") {
    throw firstError;
  }

  logger.warn("Initial offscreen tab stream failed; retrying with a fresh stream id.", toErrorMessage(firstError));
  const retryStreamId = await getTabMediaStreamId(tabId);
  const retryResponse = await sendStartCapture(session, retryStreamId);
  if (!retryResponse.ok) {
    throw retryResponse.error ?? captureError("GET_USER_MEDIA_FAILED", "Offscreen capture did not start after retry.", undefined, session.id);
  }
}

async function sendStartCapture(session: CaptureSession, streamId: string): Promise<CaptureCommandResponse> {
  try {
    return await chrome.runtime.sendMessage<RuntimeMessage, CaptureCommandResponse>({
      type: "START_CAPTURE",
      session,
      streamId
    });
  } catch (error) {
    return { ok: false, error: normalizeCaptureError(error, session.id) };
  }
}

async function handleRuntimeMessage(message: RuntimeMessage): Promise<void> {
  switch (message.type) {
    case "FRAME_SAMPLED":
      await handleFrameSampled(message);
      return;
    case "VIDEO_PROBE_TICK":
      await handleVideoTick(message);
      return;
    case "VIDEO_ENDED":
      await handleVideoEnded(message.sessionId);
      return;
    case "CAPTURE_ERROR":
      await handleCaptureError(message.error.sessionId, message.error);
      return;
    case "CAPTURE_STOPPED":
      await finishStoppedCapture(message.sessionId, message.reason);
      return;
  }
}

function isBackgroundCaptureEvent(message: RuntimeMessage): message is BackgroundCaptureEvent {
  return message.type === "FRAME_SAMPLED" || message.type === "CAPTURE_STOPPED";
}

function enqueueCaptureMessage(message: BackgroundCaptureEvent): Promise<CaptureCommandResponse> {
  captureMessageQueue = captureMessageQueue.then(() => handleRuntimeMessage(message));
  const currentTask = captureMessageQueue;
  captureMessageQueue = currentTask.catch((error) => {
    logger.error("Serialized capture message failed", {
      type: message.type,
      sessionId: message.sessionId,
      error: toErrorMessage(error)
    });
  });

  return currentTask.then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error: normalizeCaptureError(error, message.sessionId) })
  );
}

async function handleFrameSampled(message: FrameMetaMessage): Promise<void> {
  const session = await sessionManager.getCurrentSession();

  if (!session || session.id !== message.sessionId) {
    return;
  }

  const updated = await sessionManager.updateStats(message.sessionId, {
    framesSampled: message.frameIndex,
    lastTimestampSec: message.timestampSec,
    lastFrameWidth: message.width,
    lastFrameHeight: message.height
  });

  if (updated) {
    await recordDebugFrame(updated, message);
  }

  logger.debug(`Frame #${message.frameIndex} | t=${message.timestampSec.toFixed(2)}s | ${message.width}x${message.height}`);
}

async function handleVideoTick(message: Extract<RuntimeMessage, { type: "VIDEO_PROBE_TICK" }>): Promise<void> {
  const tick = message;

  await chrome.runtime.sendMessage<RuntimeMessage>({
    type: "VIDEO_TIMING_UPDATE",
    tick
  });

  if (tick.paused) {
    const current = await sessionManager.getCurrentSession();
    if (current?.id === tick.sessionId && current.state === "running") {
      const paused = await sessionManager.setState(tick.sessionId, "paused");
      if (paused) {
        await recordDebugSession(paused);
      }
    }
    return;
  }

  const current = await sessionManager.getCurrentSession();
  if (current?.id === tick.sessionId && current.state === "paused") {
    const running = await sessionManager.setState(tick.sessionId, "running");
    if (running) {
      await recordDebugSession(running);
    }
  }
}

async function handleVideoEnded(sessionId: string): Promise<void> {
  const session = await sessionManager.getCurrentSession();

  if (!session || session.id !== sessionId) {
    return;
  }

  await stopSession(session, "completed");
}

async function handleCaptureError(sessionId: string | undefined, error: unknown): Promise<void> {
  await recordDebugError(normalizeCaptureError(error, sessionId));
  logger.error("Capture error", error);

  if (!sessionId) {
    return;
  }

  const session = await sessionManager.getCurrentSession();

  if (!session || session.id !== sessionId) {
    return;
  }

  if (session.state === "starting") {
    await failSessionStartup(session, error);
    return;
  }

  await stopSession(session, "error");
}

async function stopSessionForTab(tabId: number, reason: "stopped" | "completed" | "error"): Promise<void> {
  const session = await sessionManager.getCurrentSession();

  if (session?.tabId === tabId) {
    await stopSession(session, reason);
  }
}

async function stopSession(session: CaptureSession, reason: "stopped" | "completed" | "error"): Promise<void> {
  await sessionManager.setState(session.id, "stopping");

  const stopDelivered = await sendStopCapture(session.id, reason);

  if (!stopDelivered) {
    await finishStoppedCapture(session.id, reason);
  }

  try {
    await chrome.tabs.sendMessage<RuntimeMessage>(session.tabId, {
      type: "STOP_VIDEO_PROBE",
      sessionId: session.id
    });
  } catch {
    // The tab may already be closed or navigated away.
  }
}

async function failSessionStartup(session: CaptureSession, error: unknown): Promise<void> {
  try {
    await chrome.tabs.sendMessage<RuntimeMessage>(session.tabId, {
      type: "STOP_VIDEO_PROBE",
      sessionId: session.id
    });
  } catch {
    // The probe may not have started yet.
  }

  await sendStopCapture(session.id, "error");
  const failedSession = await sessionManager.setState(session.id, "error");
  if (failedSession) {
    await recordDebugSession(failedSession, true);
  }
  await recordDebugError(normalizeCaptureError(error, session.id));
  await sessionManager.clear(session.id);
  await offscreenManager.closeDocument();
  logger.error("Session startup failed", toErrorMessage(error));
}

async function sendStopCapture(sessionId: string, reason: "stopped" | "completed" | "error"): Promise<boolean> {
  try {
    const response = await chrome.runtime.sendMessage<RuntimeMessage, CaptureCommandResponse>({
      type: "STOP_CAPTURE",
      sessionId,
      reason
    });
    return response?.ok === true;
  } catch {
    // The offscreen document may not exist or may already be closing.
    return false;
  }
}

function isActiveSessionState(session: CaptureSession): boolean {
  return session.state === "starting" || session.state === "running" || session.state === "paused" || session.state === "stopping";
}

function isRecoverableStaleSession(session: CaptureSession): boolean {
  if (session.state !== "starting" && session.state !== "stopping") {
    return false;
  }

  const startedAtMs = Date.parse(session.stats.startedAt);
  if (!Number.isFinite(startedAtMs)) {
    return true;
  }

  return Date.now() - startedAtMs > STALE_TRANSITION_SESSION_MS;
}

async function finishStoppedCapture(sessionId: string, reason: "stopped" | "completed" | "error"): Promise<void> {
  const state = reason === "completed" ? "completed" : reason === "error" ? "error" : "stopped";
  const session = await sessionManager.setState(sessionId, state);

  if (!session) {
    return;
  }

  logger.info("Session stopped", {
    state,
    framesSampled: session.stats.framesSampled,
    framesDropped: session.stats.framesDropped,
    lastTimestampSec: session.stats.lastTimestampSec
  });

  await recordDebugSession(session, true);
  await notifyExportReady(session);
  await sessionManager.clear(sessionId);
  await offscreenManager.closeDocument();
}

async function notifyExportReady(session: CaptureSession): Promise<void> {
  const state = await readDebugState();
  const scores = reviewScoresForExport(state);
  const scoreCount = scores.length;

  if (scoreCount === 0) {
    logger.warn("Export ready notification skipped because no captured scores were persisted.", { sessionId: session.id });
    return;
  }

  try {
    await chrome.tabs.sendMessage<RuntimeMessage>(session.tabId, {
      type: "SCORE_EXPORT_READY",
      sessionId: session.id,
      videoTitle: session.source.title,
      scoreCount,
      pageCount: packScorePages(scores).length,
      pageLayout: SCORE_IDENTITY_CONFIG.page
    });
  } catch (error) {
    logger.warn("Unable to open the export review panel.", { sessionId: session.id, error: toErrorMessage(error) });
  }
}

async function getExportReviewData(
  message: Extract<RuntimeMessage, { type: "GET_EXPORT_REVIEW_DATA" }>
): Promise<ExportReviewDataResponse> {
  try {
    const state = await readDebugState();
    const session = state.currentSession?.id === message.sessionId ? state.currentSession : state.lastCompletedSession;

    if (!session || session.id !== message.sessionId) {
      throw captureError("SESSION_NOT_FOUND", "No completed score capture is available for review.", undefined, message.sessionId);
    }

    return { ok: true, scores: state.uniqueScores, exportOccurrences: state.exportOccurrences, exportCandidates: state.exportCandidates };
  } catch (error) {
    return { ok: false, error: normalizeCaptureError(error, message.sessionId) };
  }
}

async function validateExportReview(
  message: Extract<RuntimeMessage, { type: "VALIDATE_EXPORT_REVIEW" }>
): Promise<ExportReviewValidationResponse> {
  try {
    const state = await readDebugState();
    const session = state.currentSession?.id === message.sessionId ? state.currentSession : state.lastCompletedSession;

    if (!session || session.id !== message.sessionId) {
      throw captureError("SESSION_NOT_FOUND", "No completed score capture is available for review.", undefined, message.sessionId);
    }

    const reviewScores = reviewScoresForExport(state);

    if (reviewScores.length === 0) {
      throw captureError("SESSION_NOT_FOUND", "No unique score images are available for review.", undefined, message.sessionId);
    }

    const validation = await validateExportScores(reviewScores, {
      occurrenceOrder: message.occurrenceOrder,
      scoreOrder: message.scoreOrder,
      candidates: state.exportCandidates
    });

    return { ok: true, validation: validation.summary, validationDetails: validation.decisions };
  } catch (error) {
    const normalized = normalizeCaptureError(error, message.sessionId);
    await recordDebugError(normalized);
    return { ok: false, error: normalized };
  }
}

async function previewScoreExport(
  message: Extract<RuntimeMessage, { type: "PREVIEW_SCORE_EXPORT" }>
): Promise<PreviewScoreExportResponse> {
  try {
    const state = await readDebugState();
    const session = state.currentSession?.id === message.sessionId ? state.currentSession : state.lastCompletedSession;

    if (!session || session.id !== message.sessionId) {
      throw captureError("SESSION_NOT_FOUND", "No completed score capture is available for preview.", undefined, message.sessionId);
    }

    const reviewScores = reviewScoresForExport(state);

    if (reviewScores.length === 0) {
      throw captureError("SESSION_NOT_FOUND", "No unique score images are available for preview.", undefined, message.sessionId);
    }

    const validation = await validateExportScores(reviewScores, {
      occurrenceOrder: message.occurrenceOrder,
      scoreOrder: message.scoreOrder,
      candidates: state.exportCandidates
    });
    const validatedScores = validation.scores;
    const exportOptions = buildValidatedExportOptions(validatedScores, validation.decisions);

    if (validatedScores.length === 0) {
      throw captureError("SESSION_NOT_FOUND", "No readable score images are available for preview.", undefined, message.sessionId);
    }

    const pageBlobs = await exportScoresAsPngPages(validatedScores, exportOptions);
    const pageDataUrls = await Promise.all(pageBlobs.map((blob) => blobToDataUrl(blob)));

    return {
      ok: true,
      validation: validation.summary,
      validationDetails: validation.decisions,
      pageCount: pageDataUrls.length,
      pages: pageDataUrls.map((dataUrl, pageIndex) => ({ pageIndex, dataUrl }))
    };
  } catch (error) {
    const normalized = normalizeCaptureError(error, message.sessionId);
    await recordDebugError(normalized);
    return { ok: false, error: normalized };
  }
}

async function exportScoreCapture(
  message: Extract<RuntimeMessage, { type: "EXPORT_SCORE_CAPTURE" }>
): Promise<ExportScoreCaptureResponse> {
  try {
    const state = await readDebugState();
    const session = state.currentSession?.id === message.sessionId ? state.currentSession : state.lastCompletedSession;

    if (!session || session.id !== message.sessionId) {
      throw captureError("SESSION_NOT_FOUND", "No completed score capture is available for export.", undefined, message.sessionId);
    }

    const fileBaseName = safeFileBaseName(`${session.source.title || session.source.videoId}-score`);

    if (message.format === "pdf") {
      const pdf = await exportApprovedPreviewAsPdf(message.pages);
      await downloadBlob(pdf, `${fileBaseName}.pdf`);
      return { ok: true, downloadCount: 1 };
    }

    const pages = previewPageBlobs(message.pages);
    for (let index = 0; index < pages.length; index += 1) {
      await downloadBlob(pages[index], `${fileBaseName}-page-${String(index + 1).padStart(2, "0")}.png`);
    }
    return { ok: true, downloadCount: pages.length };
  } catch (error) {
    const normalized = normalizeCaptureError(error, message.sessionId);
    await recordDebugError(normalized);
    return { ok: false, error: normalized };
  }
}

async function downloadBlob(blob: Blob, filename: string): Promise<void> {
  const url = await blobToDataUrl(blob);
  await chrome.downloads.download({
    url,
    filename,
    saveAs: true
  });
}

async function readDebugState(): Promise<DebugCaptureState> {
  return captureImageStorage.hydrate(await readStoredDebugState());
}

async function readStoredDebugState(): Promise<DebugCaptureState> {
  const stored = await chrome.storage.session.get(DEBUG_CAPTURE_STATE_KEY);
  const state = stored[DEBUG_CAPTURE_STATE_KEY] as Partial<DebugCaptureState> | undefined;

  return {
    currentSession: state?.currentSession ?? null,
    lastCompletedSession: state?.lastCompletedSession ?? null,
    recentFrames: state?.recentFrames ?? [],
    uniqueScores: state?.uniqueScores ?? [],
    exportOccurrences: state?.exportOccurrences,
    exportCandidates: state?.exportCandidates ?? state?.uniqueScores ?? [],
    lastError: state?.lastError ?? null,
    updatedAt: state?.updatedAt ?? new Date().toISOString()
  };
}

async function writeDebugState(state: DebugCaptureState): Promise<void> {
  const compacted = await captureImageStorage.persist(state);
  await chrome.storage.session.set({ [DEBUG_CAPTURE_STATE_KEY]: compacted });
}

async function recordDebugSession(session: CaptureSession, terminal = false): Promise<void> {
  const state = await readStoredDebugState();
  if (!terminal && session.state === "starting") {
    await captureImageStorage.clear();
  }
  await writeDebugState({
    ...state,
    currentSession: terminal ? null : session,
    lastCompletedSession: terminal ? session : state.lastCompletedSession,
    uniqueScores: !terminal && session.state === "starting" ? [] : state.uniqueScores,
    exportOccurrences: !terminal && session.state === "starting" ? undefined : state.exportOccurrences,
    exportCandidates: !terminal && session.state === "starting" ? [] : state.exportCandidates,
    updatedAt: new Date().toISOString()
  });
}

async function recordDebugFrame(session: CaptureSession, frame: FrameMetaMessage): Promise<void> {
  const state = await readStoredDebugState();
  const recentFrames = [...state.recentFrames, withoutUniqueScores(frame)].slice(-MAX_DEBUG_FRAMES);
  const previewStartIndex = Math.max(0, recentFrames.length - MAX_DEBUG_PREVIEWS);
  const newestIndex = recentFrames.length - 1;

  await writeDebugState({
    ...state,
    currentSession: session,
    uniqueScores: frame.uniqueScores ?? state.uniqueScores,
    exportOccurrences: frame.exportOccurrences ?? state.exportOccurrences,
    exportCandidates: frame.exportCandidates ?? state.exportCandidates,
    recentFrames: recentFrames.map((recentFrame, index) => {
      const previewFrame = index < previewStartIndex ? withoutPreview(recentFrame) : recentFrame;
      return index === newestIndex ? previewFrame : compactLayoutFrame(previewFrame);
    }),
    updatedAt: new Date().toISOString()
  });
}

async function recordDebugError(error: CaptureError): Promise<void> {
  const state = await readStoredDebugState();
  await writeDebugState({
    ...state,
    lastError: error,
    updatedAt: new Date().toISOString()
  });
}

function normalizeCaptureError(error: unknown, sessionId?: string): CaptureError {
  if (isCaptureError(error)) {
    return error;
  }

  return captureError("UNKNOWN", toErrorMessage(error), undefined, sessionId);
}

function reviewScoresForExport(state: DebugCaptureState): DebugUniqueScore[] {
  const occurrenceScores = state.exportOccurrences ?? [];
  const scores = occurrenceScores.length > 0 ? occurrenceScores : state.uniqueScores;
  return scores.filter((score) => Boolean(score.image.dataUrl));
}

function buildValidatedExportOptions(
  validatedScores: readonly DebugUniqueScore[],
  validationDetails: readonly ExportValidationDetail[]
): ScoreExportOptions {
  const occurrenceOrder = validatedScores.flatMap((score) => score.occurrenceId !== undefined ? [score.occurrenceId] : []);
  if (occurrenceOrder.length === validatedScores.length && occurrenceOrder.length > 0) {
    return { occurrenceOrder };
  }

  return {
    scoreOrder: validationDetails
      .filter((detail) => detail.action !== "excluded")
      .map((detail) => detail.clusterId)
  };
}

function isCaptureError(error: unknown): error is CaptureError {
  return typeof error === "object" && error !== null && "code" in error && "message" in error;
}

function withoutPreview(frame: FrameMetaMessage): FrameMetaMessage {
  const { previewDataUrl, previewWidth, previewHeight, ...metadata } = frame;
  void previewDataUrl;
  void previewWidth;
  void previewHeight;
  return metadata;
}

function withoutUniqueScores(frame: FrameMetaMessage): FrameMetaMessage {
  const { uniqueScores, exportOccurrences, exportCandidates, ...metadata } = frame;
  void uniqueScores;
  void exportOccurrences;
  void exportCandidates;
  return metadata;
}

function compactLayoutFrame(frame: FrameMetaMessage): FrameMetaMessage {
  if (!frame.layout) {
    return frame;
  }

  return {
    ...frame,
    layout: {
      ...frame.layout,
      scoreRegions: [],
      regionProposals: [],
      weakCandidates: [],
      promotedCandidates: [],
      debug: undefined
    }
  };
}
