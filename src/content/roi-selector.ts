// allow: SIZE_OK - inherited injected content script; accepted debt until a safe no-runtime-import split preserves injection behavior.
import type { DebugScoreOccurrence, DebugUniqueScore, ExportReviewDataResponse, ExportReviewValidationResponse, ExportScoreCaptureResponse, ExportValidationDetail, ExportValidationSummary, PreviewScoreExportResponse, RuntimeMessage, SelectScoreRoiResponse } from "../shared/messages";
import type { CaptureError } from "../shared/types";
import type { ScoreRoiConfig } from "../shared/roi-types";
import type { ScorePageLayoutConfig } from "../shared/score-page-layout";

type RoiSelectorMessage = {
  type: "SELECT_SCORE_ROI";
  videoId: string;
  url: string;
  sampleIntervalMs: number;
};

type ScoreExportReadyMessage = Extract<RuntimeMessage, { type: "SCORE_EXPORT_READY" }>;
type ContentMessage = RoiSelectorMessage | ScoreExportReadyMessage;
type ExportFormat = Extract<RuntimeMessage, { type: "EXPORT_SCORE_CAPTURE" }>["format"];
type ReviewedScore = {
  score: DebugUniqueScore;
  occurrenceId?: string;
  occurrenceOrder?: number;
  repeatIndex?: number;
  repeatCount?: number;
  previousOccurrenceId?: string;
  nextOccurrenceId?: string;
  duplicateCount: number;
  included: boolean;
  validationAction?: ExportValidationDetail["action"];
  validationReason?: string;
  replacementScoreId?: string;
  validator?: ExportValidationDetail["validator"];
};

type ExportReviewData = {
  scores: DebugUniqueScore[];
  exportOccurrences?: DebugScoreOccurrence[];
  exportCandidates: DebugUniqueScore[];
};

type ReviewOrderPayload =
  | {
      occurrenceOrder: string[];
      scoreOrder?: undefined;
    }
  | {
      occurrenceOrder?: undefined;
      scoreOrder: string[];
    };

type PreviewState = Extract<PreviewScoreExportResponse, { ok: true }>;

type ReviewSummary = {
  readonly totalCount: number;
  readonly includedCount: number;
  readonly excludedCount: number;
  readonly attentionCount: number;
  readonly repeatedClusterCount: number;
  readonly pageCount: number;
};

type RoiViewportRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type RoiDragPoint = {
  x: number;
  y: number;
};

type RoiDragState =
  | {
      mode: "draw";
      start: RoiDragPoint;
    }
  | {
      mode: "move";
      pointerOffset: RoiDragPoint;
      rect: RoiViewportRect;
    };

type SelectorState = {
  active: boolean;
  listenerRegistered: boolean;
  cleanup?: () => void;
  exportCleanup?: () => void;
  imageViewerCleanup?: () => void;
};

declare global {
  interface Window {
    __scoreRoiSelector?: SelectorState;
  }
}

const STORAGE_PREFIX = "scoreRoiConfig:";
const IMAGE_VIEWER_ZOOM_LEVELS = [50, 75, 100, 125, 150, 175, 200, 225, 250, 275, 300] as const;
const IMAGE_VIEWER_DEFAULT_ZOOM_INDEX = 2;

const selectorState = (window.__scoreRoiSelector ??= {
  active: false,
  listenerRegistered: false
});

if (!selectorState.listenerRegistered) {
  chrome.runtime.onMessage.addListener((message: ContentMessage, _sender, sendResponse: (response: SelectScoreRoiResponse) => void) => {
    if (message.type === "SELECT_SCORE_ROI") {
      void selectRoi(message).then(sendResponse);
      return true;
    }

    if (message.type === "SCORE_EXPORT_READY") {
      showExportReviewPanel(message);
    }

    return false;
  });
  selectorState.listenerRegistered = true;
}

async function selectRoi(message: RoiSelectorMessage): Promise<SelectScoreRoiResponse> {
  if (selectorState.cleanup) {
    selectorState.cleanup();
  }

  const video = document.querySelector("video");
  if (!video) {
    return { ok: false, error: captureError("VIDEO_ELEMENT_NOT_FOUND", "Unable to find the YouTube video element.") };
  }

  const initialRect = await loadInitialRect(message.videoId, video);

  return new Promise((resolve) => {
    selectorState.active = true;
    const overlay = document.createElement("div");
    const selection = document.createElement("div");
    const toolbar = document.createElement("div");
    const useButton = document.createElement("button");
    const cancelButton = document.createElement("button");
    let dragState: RoiDragState | null = null;
    let selectedRect: RoiViewportRect | null = initialRect;

    overlay.className = "score-roi-overlay";
    selection.className = "score-roi-selection";
    toolbar.className = "score-roi-toolbar";
    useButton.type = "button";
    useButton.textContent = "Use this area";
    cancelButton.type = "button";
    cancelButton.textContent = "Cancel";
    applySelectorInlineStyles(overlay, selection, toolbar, useButton, cancelButton);
    toolbar.append(useButton, cancelButton);
    overlay.append(selection, toolbar);
    document.body.append(overlay);

    const cleanup = () => {
      overlay.remove();
      selectorState.active = false;
      selectorState.cleanup = undefined;
      window.removeEventListener("resize", syncInitialSelection);
    };
    selectorState.cleanup = cleanup;

    const finish = async () => {
      if (!selectedRect) {
        return;
      }

      const roiConfig = toScoreRoiConfig(message, video, selectedRect);
      await chrome.storage.local.set({ [storageKey(message.videoId)]: roiConfig });
      cleanup();
      resolve({ ok: true, roiConfig });
    };

    const cancel = () => {
      cleanup();
      resolve({ ok: false, error: captureError("ROI_SELECTION_CANCELLED", "Score ROI selection was cancelled.") });
    };

    const paintSelection = () => {
      if (!selectedRect) {
        selection.style.display = "none";
        toolbar.style.display = "none";
        return;
      }

      selection.style.display = "block";
      selection.style.left = `${selectedRect.left}px`;
      selection.style.top = `${selectedRect.top}px`;
      selection.style.width = `${selectedRect.width}px`;
      selection.style.height = `${selectedRect.height}px`;
      toolbar.style.display = "flex";
      toolbar.style.left = `${selectedRect.left}px`;
      toolbar.style.top = `${Math.max(8, selectedRect.top - 46)}px`;
    };

    const syncInitialSelection = () => {
      if (!selectedRect) {
        return;
      }
      selectedRect = clampDragRect(selectedRect, getVideoContentRect(video));
      paintSelection();
    };

    overlay.addEventListener("pointerdown", (event) => {
      if (event.target === useButton || event.target === cancelButton) {
        return;
      }

      const bounds = getVideoContentRect(video);
      dragState = beginRoiDrag({ x: event.clientX, y: event.clientY }, selectedRect, bounds);
      selectedRect = updateRoiDrag(dragState, { x: event.clientX, y: event.clientY }, bounds);
      overlay.setPointerCapture(event.pointerId);
      paintSelection();
    });

    overlay.addEventListener("pointermove", (event) => {
      if (!dragState) {
        return;
      }

      selectedRect = updateRoiDrag(dragState, { x: event.clientX, y: event.clientY }, getVideoContentRect(video));
      paintSelection();
    });

    overlay.addEventListener("pointerup", (event) => {
      dragState = null;
      if (overlay.hasPointerCapture(event.pointerId)) {
        overlay.releasePointerCapture(event.pointerId);
      }
    });

    useButton.addEventListener("click", () => {
      void finish();
    });
    cancelButton.addEventListener("click", cancel);
    window.addEventListener("resize", syncInitialSelection);
    paintSelection();
  });
}

async function loadInitialRect(videoId: string, video: HTMLVideoElement): Promise<RoiViewportRect | null> {
  const stored = await chrome.storage.local.get(storageKey(videoId));
  const config = stored[storageKey(videoId)] as ScoreRoiConfig | undefined;
  return config?.coordinateSpace === "frame" ? frameRectToViewportRect(video, config.roiRect) : defaultSelection(video);
}

function defaultSelection(video: HTMLVideoElement): RoiViewportRect {
  const rect = getVideoContentRect(video);
  return {
    left: rect.left + rect.width * 0.08,
    top: rect.top + rect.height * 0.08,
    width: rect.width * 0.84,
    height: rect.height * 0.36
  };
}

function applySelectorInlineStyles(
  overlay: HTMLDivElement,
  selection: HTMLDivElement,
  toolbar: HTMLDivElement,
  useButton: HTMLButtonElement,
  cancelButton: HTMLButtonElement
): void {
  Object.assign(overlay.style, {
    background: "rgba(0, 0, 0, 0.28)",
    cursor: "crosshair",
    inset: "0",
    position: "fixed",
    touchAction: "none",
    userSelect: "none",
    zIndex: "2147483647"
  });

  Object.assign(selection.style, {
    border: "2px solid #22c55e",
    boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.24)",
    boxSizing: "border-box",
    display: "none",
    pointerEvents: "none",
    position: "fixed"
  });

  Object.assign(toolbar.style, {
    display: "none",
    gap: "8px",
    position: "fixed"
  });

  applySelectorButtonStyles(useButton, "#111827", "#ffffff");
  applySelectorButtonStyles(cancelButton, "#f3f4f6", "#111827");
}

function applySelectorButtonStyles(button: HTMLButtonElement, background: string, color: string): void {
  Object.assign(button.style, {
    background,
    border: "1px solid rgba(255, 255, 255, 0.24)",
    borderRadius: "6px",
    color,
    cursor: "pointer",
    font: '13px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    padding: "9px 12px"
  });
}

function toScoreRoiConfig(message: RoiSelectorMessage, video: HTMLVideoElement, selectedRect: RoiViewportRect): ScoreRoiConfig {
  const videoRect = video.getBoundingClientRect();
  const frameWidth = Math.max(1, video.videoWidth || Math.round(videoRect.width));
  const frameHeight = Math.max(1, video.videoHeight || Math.round(videoRect.height));
  const viewportRect = clampDragRect(selectedRect, getVideoContentRect(video));

  const roiConfig: ScoreRoiConfig = {
    id: crypto.randomUUID(),
    videoId: message.videoId,
    url: message.url,
    roiRect: viewportRectToFrameRect({
      selectionRect: viewportRect,
      videoRect,
      frameSize: { width: frameWidth, height: frameHeight }
    }),
    frameSize: { width: frameWidth, height: frameHeight },
    coordinateSpace: "frame",
    createdAt: new Date().toISOString(),
    sampleIntervalMs: message.sampleIntervalMs
  };

  return roiConfig;
}

function frameRectToViewportRect(video: HTMLVideoElement, rect: ScoreRoiConfig["roiRect"]): RoiViewportRect {
  const videoRect = video.getBoundingClientRect();
  const contentRect = getVideoContentRect(video);
  const scaleX = contentRect.width / Math.max(1, video.videoWidth || videoRect.width);
  const scaleY = contentRect.height / Math.max(1, video.videoHeight || videoRect.height);
  return clampDragRect({
    left: contentRect.left + rect.x * scaleX,
    top: contentRect.top + rect.y * scaleY,
    width: rect.width * scaleX,
    height: rect.height * scaleY
  }, contentRect);
}

function getVideoContentRect(video: HTMLVideoElement): RoiViewportRect {
  const rect = video.getBoundingClientRect();
  return videoContentRect(
    { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    {
      width: Math.max(1, video.videoWidth || Math.round(rect.width)),
      height: Math.max(1, video.videoHeight || Math.round(rect.height))
    }
  );
}

function beginRoiDrag(point: RoiDragPoint, existingRect: RoiViewportRect | null, bounds: RoiViewportRect): RoiDragState {
  const start = clampPoint(point, bounds);
  const clampedExistingRect = existingRect ? clampDragRect(existingRect, bounds) : null;

  if (clampedExistingRect && containsPoint(clampedExistingRect, start)) {
    return {
      mode: "move",
      pointerOffset: {
        x: start.x - clampedExistingRect.left,
        y: start.y - clampedExistingRect.top
      },
      rect: clampedExistingRect
    };
  }

  return { mode: "draw", start };
}

function updateRoiDrag(state: RoiDragState, point: RoiDragPoint, bounds: RoiViewportRect): RoiViewportRect {
  const current = clampPoint(point, bounds);

  if (state.mode === "move") {
    return clampMovedRect(
      {
        left: current.x - state.pointerOffset.x,
        top: current.y - state.pointerOffset.y,
        width: state.rect.width,
        height: state.rect.height
      },
      bounds
    );
  }

  return {
    left: Math.min(state.start.x, current.x),
    top: Math.min(state.start.y, current.y),
    width: Math.abs(current.x - state.start.x),
    height: Math.abs(current.y - state.start.y)
  };
}

function clampDragRect(rect: RoiViewportRect, bounds: RoiViewportRect): RoiViewportRect {
  const left = Math.max(bounds.left, Math.min(bounds.left + bounds.width, rect.left));
  const top = Math.max(bounds.top, Math.min(bounds.top + bounds.height, rect.top));
  const right = Math.max(left, Math.min(bounds.left + bounds.width, rect.left + rect.width));
  const bottom = Math.max(top, Math.min(bounds.top + bounds.height, rect.top + rect.height));
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top)
  };
}

function viewportRectToFrameRect(input: {
  selectionRect: RoiViewportRect;
  videoRect: RoiViewportRect;
  frameSize: { width: number; height: number };
}): ScoreRoiConfig["roiRect"] {
  const contentRect = videoContentRect(input.videoRect, input.frameSize);
  const scaleX = input.frameSize.width / Math.max(1, contentRect.width);
  const scaleY = input.frameSize.height / Math.max(1, contentRect.height);
  const left = clamp(input.selectionRect.left, contentRect.left, contentRect.left + contentRect.width);
  const top = clamp(input.selectionRect.top, contentRect.top, contentRect.top + contentRect.height);
  const right = clamp(input.selectionRect.left + input.selectionRect.width, contentRect.left, contentRect.left + contentRect.width);
  const bottom = clamp(input.selectionRect.top + input.selectionRect.height, contentRect.top, contentRect.top + contentRect.height);

  return {
    x: Math.round((left - contentRect.left) * scaleX),
    y: Math.round((top - contentRect.top) * scaleY),
    width: Math.max(1, Math.round((right - left) * scaleX)),
    height: Math.max(1, Math.round((bottom - top) * scaleY))
  };
}

function videoContentRect(videoRect: RoiViewportRect, frameSize: { width: number; height: number }): RoiViewportRect {
  const frameAspect = Math.max(1, frameSize.width) / Math.max(1, frameSize.height);
  const elementAspect = Math.max(1, videoRect.width) / Math.max(1, videoRect.height);

  if (Math.abs(frameAspect - elementAspect) < 0.001) {
    return videoRect;
  }

  if (elementAspect > frameAspect) {
    const width = videoRect.height * frameAspect;
    return {
      left: videoRect.left + (videoRect.width - width) / 2,
      top: videoRect.top,
      width,
      height: videoRect.height
    };
  }

  const height = videoRect.width / frameAspect;
  return {
    left: videoRect.left,
    top: videoRect.top + (videoRect.height - height) / 2,
    width: videoRect.width,
    height
  };
}

function clampPoint(point: RoiDragPoint, bounds: RoiViewportRect): RoiDragPoint {
  return {
    x: Math.max(bounds.left, Math.min(bounds.left + bounds.width, point.x)),
    y: Math.max(bounds.top, Math.min(bounds.top + bounds.height, point.y))
  };
}

function containsPoint(rect: RoiViewportRect, point: RoiDragPoint): boolean {
  return point.x >= rect.left && point.x <= rect.left + rect.width && point.y >= rect.top && point.y <= rect.top + rect.height;
}

function clampMovedRect(rect: RoiViewportRect, bounds: RoiViewportRect): RoiViewportRect {
  const width = Math.min(Math.max(1, rect.width), Math.max(1, bounds.width));
  const height = Math.min(Math.max(1, rect.height), Math.max(1, bounds.height));
  const left = Math.max(bounds.left, Math.min(bounds.left + bounds.width - width, rect.left));
  const top = Math.max(bounds.top, Math.min(bounds.top + bounds.height - height, rect.top));

  return { left, top, width, height };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function storageKey(videoId: string): string {
  return `${STORAGE_PREFIX}${videoId}`;
}

function exportCompleteStatus(response: Extract<ExportScoreCaptureResponse, { ok: true }>): string {
  const validation = response.validation;
  const base = `${response.downloadCount}개 파일 다운로드를 시작했습니다.`;

  const validationText = validation ? validationChangeText(validation) : "";
  return validationText ? `${base} 검토 결과: ${validationText}.` : base;
}

function reviewValidationStatus(validation: ExportValidationSummary): string {
  const validationText = validationChangeText(validation);
  const source = "로컬 검토";
  return validationText ? `${source} 완료: ${validationText}.` : `${source} 완료: 대체/제외 없이 내보낼 수 있습니다.`;
}

function validationChangeText(validation: ExportValidationSummary): string {
  if (validation.excludedCount + validation.replacedCount === 0) {
    return "";
  }

  return [
    validation.replacedCount > 0 ? `대체 ${validation.replacedCount}개` : "",
    validation.excludedCount > 0 ? `제외 ${validation.excludedCount}개` : ""
  ].filter(Boolean).join(", ");
}

function showExportReviewPanel(message: ScoreExportReadyMessage): void {
  if (selectorState.exportCleanup) {
    selectorState.exportCleanup();
  }

  const panel = document.createElement("section");
  const header = document.createElement("div");
  const text = document.createElement("div");
  const title = document.createElement("h2");
  const meta = document.createElement("p");
  const closeButton = document.createElement("button");
  const statusBar = document.createElement("div");
  const spinner = document.createElement("span");
  const status = document.createElement("p");
  const body = document.createElement("div");
  const summary = document.createElement("div");
  const selectedScore = document.createElement("section");
  const reviewList = document.createElement("div");
  const comparisonStrip = document.createElement("section");
  const previewPanel = document.createElement("section");
  const footer = document.createElement("div");
  const actions = document.createElement("div");
  const previewButton = document.createElement("button");
  const pdfButton = document.createElement("button");
  const pngButton = document.createElement("button");
  let reviewedScores: ReviewedScore[] = [];
  let validationCandidates: DebugUniqueScore[] = [];
  let selectedIndex = 0;
  let previewState: PreviewState | null = null;
  let previewApproved = false;
  let statusMessage = "악보 목록을 불러오고 있습니다…";
  let validating = true;
  let previewing = false;
  let exporting = false;

  panel.className = "score-export-panel";
  header.className = "score-export-panel__header";
  title.className = "score-export-panel__title";
  meta.className = "score-export-panel__meta";
  closeButton.className = "score-export-panel__close";
  statusBar.className = "score-export-panel__statusbar";
  spinner.className = "score-export-panel__spinner";
  status.className = "score-export-panel__status";
  body.className = "score-export-panel__body";
  summary.className = "score-export-panel__summary";
  selectedScore.className = "score-export-panel__selected-score";
  reviewList.className = "score-export-panel__review score-export-panel__occurrence-list";
  comparisonStrip.className = "score-export-panel__comparison-strip";
  previewPanel.className = "score-export-panel__preview-panel";
  footer.className = "score-export-panel__footer";
  actions.className = "score-export-panel__actions";
  previewButton.className = "score-export-panel__button";
  pdfButton.className = "score-export-panel__button score-export-panel__button--primary";
  pngButton.className = "score-export-panel__button";

  title.textContent = "악보 내보내기";
  meta.textContent = "순서와 포함 여부를 확인하고 저장하세요.";
  closeButton.type = "button";
  closeButton.textContent = "✕";
  closeButton.setAttribute("aria-label", "닫기");
  summary.setAttribute("aria-label", "내보내기 요약");
  reviewList.setAttribute("role", "list");
  previewPanel.setAttribute("aria-label", "페이지 미리보기");
  actions.setAttribute("aria-label", "내보내기 작업");
  previewButton.type = "button";
  previewButton.textContent = "미리보기 생성";
  pdfButton.type = "button";
  pdfButton.textContent = "PDF 저장";
  pngButton.type = "button";
  pngButton.textContent = "PNG 저장";
  spinner.setAttribute("aria-hidden", "true");
  spinner.hidden = true;
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = statusMessage;
  previewButton.disabled = true;
  pdfButton.disabled = true;
  pngButton.disabled = true;

  text.append(title, meta);
  header.append(text, closeButton);
  statusBar.append(spinner, status);
  actions.append(previewButton, pdfButton, pngButton);
  footer.append(actions);
  body.append(summary, selectedScore, comparisonStrip, reviewList, previewPanel);
  panel.append(header, statusBar, body, footer);
  document.body.append(panel);

  const cleanup = () => {
    selectorState.imageViewerCleanup?.();
    panel.remove();
    selectorState.exportCleanup = undefined;
  };

  const syncReview = () => {
    selectedIndex = clampSelectedIndex(selectedIndex, reviewedScores);
    renderSelectedScore(selectedScore, reviewedScores[selectedIndex], selectedIndex + 1);
    renderReviewList(reviewList, reviewedScores, selectedIndex, {
      onSelect: (index) => {
        selectedIndex = index;
        syncReview();
      },
      onChange: () => {
        previewState = null;
        previewApproved = false;
        statusMessage = "변경한 내용이 있습니다. 미리보기를 다시 생성하세요.";
        syncReview();
      }
    });
    renderComparisonStrip(comparisonStrip, reviewedScores, selectedIndex, (index) => {
      selectedIndex = index;
      syncReview();
    });
    renderPreviewPanel(previewPanel, previewState, previewApproved, (approved) => {
      previewApproved = approved;
      statusMessage = approved ? "미리보기 확인이 완료되었습니다. 저장할 수 있습니다." : "모든 페이지를 확인한 뒤 승인해 주세요.";
      syncReview();
    });
    const reviewSummary = summarizeReview(reviewedScores, message.pageLayout);
    renderReviewSummary(summary, reviewSummary);
    meta.textContent = `${reviewSummary.includedCount}개 선택됨 · ${reviewSummary.pageCount}페이지${reviewSummary.repeatedClusterCount > 0 ? ` · 반복 ${reviewSummary.repeatedClusterCount}개` : ""}`;
    spinner.hidden = !(validating || previewing || exporting);
    status.textContent = statusMessage;
    previewButton.textContent = previewing ? "미리보기 만드는 중" : previewState ? "미리보기 새로고침" : "미리보기 생성";
    previewButton.disabled = validating || previewing || exporting || reviewSummary.includedCount === 0;
    pdfButton.disabled = validating || previewing || exporting || reviewSummary.includedCount === 0 || !previewApproved;
    pngButton.disabled = validating || previewing || exporting || reviewSummary.includedCount === 0 || !previewApproved;
  };

  const runPreview = async (): Promise<boolean> => {
    const order = selectedReviewOrder(reviewedScores);
    const selectedCount = reviewOrderCount(order);
    if (selectedCount === 0) {
      statusMessage = "내보낼 악보를 하나 이상 선택하세요.";
      syncReview();
      return false;
    }

    previewing = true;
    previewState = null;
    previewApproved = false;
    statusMessage = "미리보기를 만들고 있습니다…";
    syncReview();

    try {
      const response = await chrome.runtime.sendMessage<RuntimeMessage, PreviewScoreExportResponse>({
        type: "PREVIEW_SCORE_EXPORT",
        sessionId: message.sessionId,
        ...order
      });

      if (!response?.ok) {
        statusMessage = response?.error.message ?? "미리보기에 실패했습니다.";
        return false;
      }

      reviewedScores = applyValidationDetails(reviewedScores, validationCandidates, response.validationDetails);
      previewState = response;
      statusMessage = previewStatus(response);
      return true;
    } catch (error) {
      statusMessage = error instanceof Error ? error.message : "미리보기에 실패했습니다.";
      return false;
    } finally {
      previewing = false;
      syncReview();
    }
  };

  const runExport = async (format: ExportFormat) => {
    const order = selectedReviewOrder(reviewedScores);
    const selectedCount = reviewOrderCount(order);
    if (selectedCount === 0) {
      statusMessage = "내보낼 악보를 하나 이상 선택하세요.";
      syncReview();
      return;
    }

    if (previewState === null || !previewApproved) {
      statusMessage = "미리보기를 생성하고 모든 페이지 확인을 승인한 뒤 저장하세요.";
      syncReview();
      return;
    }

    exporting = true;
    statusMessage = format === "pdf" ? "PDF를 저장하고 있습니다…" : "PNG 페이지를 저장하고 있습니다…";
    syncReview();

    try {
      const response = await chrome.runtime.sendMessage<RuntimeMessage, ExportScoreCaptureResponse>({
        type: "EXPORT_SCORE_CAPTURE",
        sessionId: message.sessionId,
        format,
        pages: previewState.pages
      });

      if (!response?.ok) {
        statusMessage = response?.error.message ?? "저장에 실패했습니다.";
        return;
      }

      statusMessage = exportCompleteStatus(response);
    } catch (error) {
      statusMessage = error instanceof Error ? error.message : "저장에 실패했습니다.";
    } finally {
      exporting = false;
      syncReview();
    }
  };

  closeButton.addEventListener("click", cleanup);
  previewButton.addEventListener("click", () => {
    void runPreview();
  });
  pdfButton.addEventListener("click", () => {
    void runExport("pdf");
  });
  pngButton.addEventListener("click", () => {
    void runExport("png");
  });
  selectorState.exportCleanup = cleanup;

  void loadExportReviewData(message.sessionId).then(async (reviewData) => {
    reviewedScores = toReviewedScores(reviewData);
    validationCandidates = [
      ...reviewData.scores,
      ...(reviewData.exportOccurrences ?? []),
      ...reviewData.exportCandidates
    ];
    statusMessage = "악보 상태를 검토하고 있습니다…";
    syncReview();
    const validation = await validateExportReview(message.sessionId, selectedReviewOrder(reviewedScores));
    reviewedScores = applyValidationDetails(reviewedScores, validationCandidates, validation.validationDetails);
    statusMessage = `${reviewValidationStatus(validation.validation)} 미리보기나 저장을 선택하세요.`;
    validating = false;
    syncReview();
  }).catch((error) => {
    validating = true;
    statusMessage = error instanceof Error ? error.message : "검토 목록을 불러오지 못했습니다.";
    status.textContent = statusMessage;
  });
}

async function loadExportReviewData(sessionId: string): Promise<ExportReviewData> {
  const response = await chrome.runtime.sendMessage<RuntimeMessage, ExportReviewDataResponse>({
    type: "GET_EXPORT_REVIEW_DATA",
    sessionId
  });

  if (!response?.ok) {
    throw new Error(response?.error.message ?? "검토 목록을 불러오지 못했습니다.");
  }

  return { scores: response.scores, exportOccurrences: response.exportOccurrences, exportCandidates: response.exportCandidates ?? [] };
}

async function validateExportReview(sessionId: string, order: ReviewOrderPayload): Promise<Extract<ExportReviewValidationResponse, { ok: true }>> {
  const response = await chrome.runtime.sendMessage<RuntimeMessage, ExportReviewValidationResponse>({
    type: "VALIDATE_EXPORT_REVIEW",
    sessionId,
    ...order
  });

  if (!response?.ok) {
    throw new Error(response?.error.message ?? "최종 검토에 실패했습니다.");
  }

  return response;
}

function toReviewedScores(reviewData: ExportReviewData): ReviewedScore[] {
  if (reviewData.exportOccurrences && reviewData.exportOccurrences.length > 0) {
    return reviewData.exportOccurrences
      .filter((score) => Boolean(score.image.dataUrl))
      .sort(compareReviewScores)
      .map((score) => ({
        score,
        occurrenceId: score.occurrenceId,
        occurrenceOrder: score.occurrenceOrder,
        repeatIndex: score.repeatIndex,
        repeatCount: score.repeatCount,
        previousOccurrenceId: score.previousOccurrenceId,
        nextOccurrenceId: score.nextOccurrenceId,
        duplicateCount: Math.max(0, (score.repeatCount ?? 1) - 1),
        included: true
      }));
  }

  const scores = reviewData.scores;
  const exportCandidates = reviewData.exportCandidates;
  const duplicateScoreIds = new Map<string, Set<string>>();
  const byClusterId = new Map<string, DebugUniqueScore>();

  for (const score of [...scores, ...exportCandidates]) {
    if (!score.image.dataUrl) {
      continue;
    }
    duplicateScoreIds.set(score.clusterId, (duplicateScoreIds.get(score.clusterId) ?? new Set<string>()).add(score.id));
  }

  for (const score of scores) {
    if (!byClusterId.has(score.clusterId) && score.image.dataUrl) {
      byClusterId.set(score.clusterId, score);
    }
  }

  return [...byClusterId.values()]
    .sort(compareReviewScores)
    .map((score) => ({
      score,
      duplicateCount: Math.max(0, (duplicateScoreIds.get(score.clusterId)?.size ?? 1) - 1, (score.source.seenCount ?? 1) - 1),
      included: true
    }));
}

function applyValidationDetails(items: ReviewedScore[], candidates: DebugUniqueScore[], details: ExportValidationDetail[]): ReviewedScore[] {
  const candidateById = new Map(candidates.filter((candidate) => candidate.image.dataUrl).map((candidate) => [candidate.id, candidate]));
  const itemByOccurrenceId = new Map(items.flatMap((item) => item.occurrenceId ? [[item.occurrenceId, item]] : []));
  const itemByClusterId = new Map(items.map((item) => [item.score.clusterId, item]));

  for (const detail of details) {
    const item = detail.occurrenceId ? itemByOccurrenceId.get(detail.occurrenceId) : itemByClusterId.get(detail.clusterId);
    if (!item) {
      continue;
    }

    if (detail.action === "replaced" && detail.replacementScoreId) {
      item.score = candidateById.get(detail.replacementScoreId) ?? item.score;
      item.included = true;
    } else if (detail.action === "excluded") {
      item.included = false;
    }

    item.validationAction = detail.action;
    item.validationReason = detail.reason;
    item.replacementScoreId = detail.replacementScoreId;
    item.validator = detail.validator;
  }

  return items;
}

function renderSelectedScore(container: HTMLElement, item: ReviewedScore | undefined, position: number): void {
  container.replaceChildren();

  if (!item) {
    const empty = document.createElement("p");
    empty.className = "score-export-panel__empty";
    empty.textContent = "선택된 악보가 없습니다.";
    container.append(empty);
    return;
  }

  const image = document.createElement("img");
  const imageButton = createImageZoomButton(image, `악보 ${position}번 크게 보기`, "score-export-panel__selected-image");
  const details = document.createElement("div");
  const title = document.createElement("strong");
  const metaLine = document.createElement("span");
  const exportState = document.createElement("span");
  const badges = document.createElement("div");

  image.src = item.score.image.dataUrl ?? "";
  image.width = item.score.image.width;
  image.height = item.score.image.height;
  image.alt = `악보 ${position}번 미리보기`;
  details.className = "score-export-panel__selected-details";
  badges.className = "score-export-panel__badges";
  title.textContent = `악보 ${position}번`;
  metaLine.className = "score-export-panel__muted";
  exportState.textContent = item.included ? "포함됨" : "제외됨";
  exportState.className = item.included ? "score-export-panel__state score-export-panel__state--included" : "score-export-panel__state";
  metaLine.append(document.createTextNode(`${reviewTiming(item)} · `), exportState);
  badges.append(...reviewBadges(item));
  details.title = identityTooltip(item);
  details.append(title, metaLine, badges);
  container.append(imageButton, details);
}

function reviewBadges(item: ReviewedScore): HTMLElement[] {
  const badges: HTMLElement[] = [];
  const repeatCount = item.repeatCount ?? (item.duplicateCount > 0 ? item.duplicateCount + 1 : 1);

  if (repeatCount > 1) {
    const repeat = document.createElement("span");
    repeat.className = "score-export-panel__badge score-export-panel__badge--repeat";
    repeat.textContent = repeatLabel(item);
    badges.push(repeat);
  }

  const validation = document.createElement("span");
  validation.className = `score-export-panel__badge ${validationBadgeClass(item)}`;
  validation.textContent = validationLabel(item);
  validation.title = item.validationReason ?? "";
  badges.push(validation);
  return badges;
}

function validationBadgeClass(item: ReviewedScore): string {
  if (item.validationAction === "replaced" || item.validationAction === "excluded") {
    return "score-export-panel__badge--attention";
  }

  return item.validationAction === "kept" ? "score-export-panel__badge--pass" : "score-export-panel__badge--pending";
}

function identityTooltip(item: ReviewedScore): string {
  return item.occurrenceId ? `occurrence ${item.occurrenceId}` : `cluster ${item.score.clusterId}`;
}

function renderReviewSummary(container: HTMLElement, summary: ReviewSummary): void {
  container.replaceChildren(
    summaryItem("전체", String(summary.totalCount)),
    summaryItem("포함", String(summary.includedCount), summary.includedCount > 0 ? "ready" : undefined),
    summaryItem("제외", String(summary.excludedCount)),
    summaryItem("주의", String(summary.attentionCount), summary.attentionCount > 0 ? "attention" : undefined),
    summaryItem("페이지", String(summary.pageCount))
  );
}

function summaryItem(labelText: string, valueText: string, tone?: "ready" | "attention"): HTMLElement {
  const item = document.createElement("div");
  const label = document.createElement("span");
  const value = document.createElement("strong");

  item.className = tone ? `score-export-panel__summary-item score-export-panel__summary-item--${tone}` : "score-export-panel__summary-item";
  label.className = "score-export-panel__summary-label";
  value.className = "score-export-panel__summary-value";
  label.textContent = labelText;
  value.textContent = valueText;
  item.append(label, value);
  return item;
}

function renderReviewList(container: HTMLElement, items: ReviewedScore[], selectedIndex: number, handlers: { onSelect: (index: number) => void; onChange: () => void }): void {
  container.replaceChildren();

  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "score-export-panel__empty";
    empty.textContent = "내보낼 수 있는 악보 이미지가 없습니다.";
    container.append(empty);
    return;
  }

  items.forEach((item, index) => {
    const row = document.createElement("article");
    const checkbox = document.createElement("input");
    const image = document.createElement("img");
    const imageButton = createImageZoomButton(image, `악보 ${index + 1} 크게 보기`, "score-export-panel__row-image");
    const details = document.createElement("div");
    const headline = document.createElement("div");
    const name = document.createElement("strong");
    const badges = document.createElement("div");
    const meta = document.createElement("span");
    const controls = document.createElement("div");
    const upButton = document.createElement("button");
    const downButton = document.createElement("button");

    row.className = item.included ? "score-export-panel__row" : "score-export-panel__row score-export-panel__row--excluded";
    if (index === selectedIndex) {
      row.className += " score-export-panel__row--selected";
    }
    row.tabIndex = 0;
    row.setAttribute("role", "listitem");
    row.setAttribute("aria-current", index === selectedIndex ? "true" : "false");
    row.setAttribute("aria-label", `악보 ${index + 1}, ${item.included ? "포함됨" : "제외됨"}, ${validationLabel(item)}`);
    row.title = identityTooltip(item);
    checkbox.type = "checkbox";
    checkbox.checked = item.included;
    checkbox.disabled = item.validationAction === "excluded";
    checkbox.setAttribute("aria-label", `악보 ${index + 1} 포함 여부`);
    image.src = item.score.image.dataUrl ?? "";
    image.width = item.score.image.width;
    image.height = item.score.image.height;
    image.alt = `악보 ${index + 1} 미리보기`;
    details.className = "score-export-panel__details";
    headline.className = "score-export-panel__row-headline";
    name.textContent = `악보 ${index + 1}`;
    badges.className = "score-export-panel__badges";
    badges.append(...reviewBadges(item));
    headline.append(name, badges);
    meta.className = "score-export-panel__muted";
    meta.textContent = `${reviewTiming(item)} · ${item.included ? "포함됨" : "제외됨"}`;
    controls.className = "score-export-panel__order";
    upButton.type = "button";
    upButton.textContent = "위";
    upButton.disabled = index === 0;
    upButton.setAttribute("aria-label", `악보 ${index + 1} 위로 이동`);
    downButton.type = "button";
    downButton.textContent = "아래";
    downButton.disabled = index === items.length - 1;
    downButton.setAttribute("aria-label", `악보 ${index + 1} 아래로 이동`);

    checkbox.addEventListener("change", () => {
      item.included = checkbox.checked;
      handlers.onChange();
    });
    row.addEventListener("click", (event) => {
      if (event.target !== checkbox && event.target !== imageButton && event.target !== image && event.target !== upButton && event.target !== downButton) {
        handlers.onSelect(index);
      }
    });
    row.addEventListener("keydown", (event) => {
      if (event.target === row && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        handlers.onSelect(index);
      }
    });
    upButton.addEventListener("click", () => {
      moveReviewItem(items, index, index - 1);
      handlers.onChange();
    });
    downButton.addEventListener("click", () => {
      moveReviewItem(items, index, index + 1);
      handlers.onChange();
    });

    details.append(headline, meta);
    controls.append(upButton, downButton);
    row.append(checkbox, imageButton, details, controls);
    container.append(row);
  });
}

function renderComparisonStrip(container: HTMLElement, items: ReviewedScore[], selectedIndex: number, onSelect: (index: number) => void): void {
  container.replaceChildren();
  const selected = items[selectedIndex];
  if (!selected) {
    return;
  }

  const compareItems = [
    items[selectedIndex - 1] ? { label: "이전 악보", item: items[selectedIndex - 1] } : undefined,
    { label: "선택한 악보", item: selected },
    items[selectedIndex + 1] ? { label: "다음 악보", item: items[selectedIndex + 1] } : undefined
  ].filter((entry): entry is { label: string; item: ReviewedScore } => entry !== undefined);

  const repeated = items.filter((item) => item.score.clusterId === selected.score.clusterId && item.occurrenceId !== selected.occurrenceId);
  for (const item of repeated) {
    compareItems.push({ label: "같은 악보 다시 등장", item });
  }

  for (const entry of compareItems) {
    const tile = document.createElement("button");
    const image = document.createElement("img");
    const label = document.createElement("span");
    tile.type = "button";
    tile.className = entry.item === selected ? "score-export-panel__comparison-item score-export-panel__comparison-item--selected" : "score-export-panel__comparison-item";
    image.src = entry.item.score.image.dataUrl ?? "";
    image.width = entry.item.score.image.width;
    image.height = entry.item.score.image.height;
    image.alt = entry.label;
    label.textContent = entry.label;
    tile.append(image, label);
    tile.addEventListener("click", () => {
      const nextIndex = items.indexOf(entry.item);
      if (nextIndex >= 0) {
        onSelect(nextIndex);
      }
    });
    container.append(tile);
  }
}

function renderPreviewPanel(
  container: HTMLElement,
  preview: PreviewState | null,
  approved: boolean,
  onApprovalChange: (approved: boolean) => void
): void {
  container.replaceChildren();
  const title = document.createElement("strong");
  title.textContent = preview ? `미리보기 · ${preview.pageCount}페이지` : "미리보기 대기";

  if (!preview || preview.pages.length === 0) {
    const empty = document.createElement("span");
    empty.className = "score-export-panel__muted";
    empty.textContent = "저장 전 미리보기를 생성하세요.";
    container.append(title, empty);
    return;
  }

  const pages = document.createElement("div");
  pages.className = "score-export-panel__preview-pages";

  for (const page of preview.pages) {
    const figure = document.createElement("figure");
    const image = document.createElement("img");
    const imageButton = createImageZoomButton(image, `${page.pageIndex + 1}페이지 크게 보기`, "score-export-panel__preview-image");
    const caption = document.createElement("figcaption");
    figure.className = "score-export-panel__preview-page";
    image.src = page.dataUrl;
    image.alt = `미리보기 ${page.pageIndex + 1}페이지`;
    caption.textContent = `${page.pageIndex + 1} / ${preview.pageCount} 페이지`;
    figure.append(imageButton, caption);
    pages.append(figure);
  }

  const approval = document.createElement("label");
  const checkbox = document.createElement("input");
  const approvalText = document.createElement("span");
  approval.className = "score-export-panel__preview-approval";
  checkbox.type = "checkbox";
  checkbox.checked = approved;
  approvalText.textContent = "모든 미리보기 페이지를 확인했습니다.";
  checkbox.addEventListener("change", () => {
    onApprovalChange(checkbox.checked);
  });
  approval.append(checkbox, approvalText);
  container.append(title, pages, approval);
}

function createImageZoomButton(image: HTMLImageElement, labelText: string, className: string): HTMLButtonElement {
  const button = document.createElement("button");
  const label = document.createElement("span");
  button.type = "button";
  button.className = `score-export-panel__image-button ${className}`;
  button.setAttribute("aria-label", labelText);
  button.title = labelText;
  label.className = "score-export-panel__zoom-label";
  label.textContent = "크게 보기";
  button.append(image, label);
  button.addEventListener("click", () => {
    openImageViewer(image.src, image.alt);
  });
  return button;
}

function openImageViewer(src: string, alt: string): void {
  selectorState.imageViewerCleanup?.();
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const viewer = document.createElement("div");
  const toolbar = document.createElement("div");
  const title = document.createElement("strong");
  const controls = document.createElement("div");
  const zoomOutButton = document.createElement("button");
  const zoomValue = document.createElement("span");
  const zoomInButton = document.createElement("button");
  const fitButton = document.createElement("button");
  const closeButton = document.createElement("button");
  const stage = document.createElement("div");
  const image = document.createElement("img");
  let zoomIndex = IMAGE_VIEWER_DEFAULT_ZOOM_INDEX;

  viewer.className = "score-image-viewer";
  viewer.setAttribute("role", "dialog");
  viewer.setAttribute("aria-modal", "true");
  viewer.setAttribute("aria-label", `${alt} 확대 보기`);
  toolbar.className = "score-image-viewer__toolbar";
  title.className = "score-image-viewer__title";
  title.textContent = alt;
  controls.className = "score-image-viewer__controls";
  zoomOutButton.type = "button";
  zoomOutButton.textContent = "−";
  zoomOutButton.setAttribute("aria-label", "축소");
  zoomValue.className = "score-image-viewer__zoom-value";
  zoomValue.setAttribute("aria-live", "polite");
  zoomInButton.type = "button";
  zoomInButton.textContent = "+";
  zoomInButton.setAttribute("aria-label", "확대");
  fitButton.type = "button";
  fitButton.textContent = "너비 맞춤";
  closeButton.type = "button";
  closeButton.textContent = "닫기";
  stage.className = "score-image-viewer__stage";
  stage.tabIndex = 0;
  stage.setAttribute("aria-label", "확대된 이미지 스크롤 영역");
  image.className = "score-image-viewer__image";
  image.src = src;
  image.alt = alt;

  const updateZoom = () => {
    const zoom = IMAGE_VIEWER_ZOOM_LEVELS[zoomIndex] ?? 100;
    image.style.width = `${zoom}%`;
    zoomValue.textContent = `${zoom}%`;
    zoomOutButton.disabled = zoomIndex === 0;
    zoomInButton.disabled = zoomIndex === IMAGE_VIEWER_ZOOM_LEVELS.length - 1;
  };
  const changeZoom = (step: -1 | 1) => {
    zoomIndex = Math.max(0, Math.min(IMAGE_VIEWER_ZOOM_LEVELS.length - 1, zoomIndex + step));
    updateZoom();
  };
  const cleanup = () => {
    viewer.remove();
    window.removeEventListener("keydown", onKeyDown);
    selectorState.imageViewerCleanup = undefined;
    previousFocus?.focus();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cleanup();
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      changeZoom(1);
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      changeZoom(-1);
    } else if (event.key === "0") {
      event.preventDefault();
      zoomIndex = IMAGE_VIEWER_DEFAULT_ZOOM_INDEX;
      updateZoom();
    } else if (event.key === "Tab") {
      const focusable = [zoomOutButton, zoomInButton, fitButton, closeButton, stage];
      const currentIndex = focusable.findIndex((element) => element === document.activeElement);
      if (event.shiftKey && currentIndex <= 0) {
        event.preventDefault();
        stage.focus();
      } else if (!event.shiftKey && currentIndex === focusable.length - 1) {
        event.preventDefault();
        zoomOutButton.focus();
      }
    }
  };

  zoomOutButton.addEventListener("click", () => changeZoom(-1));
  zoomInButton.addEventListener("click", () => changeZoom(1));
  fitButton.addEventListener("click", () => {
    zoomIndex = IMAGE_VIEWER_DEFAULT_ZOOM_INDEX;
    updateZoom();
  });
  closeButton.addEventListener("click", cleanup);
  viewer.addEventListener("click", (event) => {
    if (event.target === viewer) {
      cleanup();
    }
  });
  window.addEventListener("keydown", onKeyDown);
  controls.append(zoomOutButton, zoomValue, zoomInButton, fitButton, closeButton);
  toolbar.append(title, controls);
  stage.append(image);
  viewer.append(toolbar, stage);
  document.body.append(viewer);
  selectorState.imageViewerCleanup = cleanup;
  updateZoom();
  closeButton.focus();
}

function moveReviewItem(items: ReviewedScore[], fromIndex: number, toIndex: number): void {
  if (toIndex < 0 || toIndex >= items.length) {
    return;
  }

  const [item] = items.splice(fromIndex, 1);
  if (item) {
    items.splice(toIndex, 0, item);
  }
}

function selectedReviewOrder(items: ReviewedScore[]): ReviewOrderPayload {
  const included = items.filter((item) => item.included);
  const occurrenceOrder = included.flatMap((item) => item.occurrenceId ? [item.occurrenceId] : []);
  if (occurrenceOrder.length === included.length && occurrenceOrder.length > 0) {
    return { occurrenceOrder };
  }

  return { scoreOrder: included.map(reviewScoreOrderItem) };
}

function summarizeReview(items: readonly ReviewedScore[], layout: ScorePageLayoutConfig): ReviewSummary {
  const included = items.filter((item) => item.included);
  const repeatedClusterCount = new Set(items.filter((item) => (item.repeatCount ?? 1) > 1).map(reviewScoreOrderItem)).size;
  const attentionCount = items.filter((item) => item.duplicateCount > 0 || item.validationAction === "replaced" || item.validationAction === "excluded").length;

  return {
    totalCount: items.length,
    includedCount: included.length,
    excludedCount: items.length - included.length,
    attentionCount,
    repeatedClusterCount,
    pageCount: countReviewPages(included, layout)
  };
}

function countReviewPages(items: readonly ReviewedScore[], layout: ScorePageLayoutConfig): number {
  const contentWidth = layout.pageWidth - layout.padding * 2;
  const contentHeight = layout.pageHeight - layout.padding * 2;
  let pageCount = 0;
  let itemCount = 0;
  let usedHeight = 0;

  for (const item of items) {
    const fittedHeight = Math.max(1, item.score.image.height * contentWidth / Math.max(1, item.score.image.width));
    const requiredHeight = fittedHeight + (itemCount > 0 ? layout.gap : 0);
    if (itemCount > 0 && usedHeight + requiredHeight > contentHeight) {
      pageCount += 1;
      itemCount = 0;
      usedHeight = 0;
    }
    usedHeight += fittedHeight + (itemCount > 0 ? layout.gap : 0);
    itemCount += 1;
  }

  return pageCount + (itemCount > 0 ? 1 : 0);
}

function reviewOrderCount(order: ReviewOrderPayload): number {
  return order.occurrenceOrder ? order.occurrenceOrder.length : order.scoreOrder.length;
}

function reviewScoreOrderItem(item: ReviewedScore): string {
  return item.score.clusterId;
}

function compareReviewScores(a: DebugUniqueScore, b: DebugUniqueScore): number {
  const occurrenceDiff = (a.occurrenceOrder ?? Number.POSITIVE_INFINITY) - (b.occurrenceOrder ?? Number.POSITIVE_INFINITY);
  if (occurrenceDiff !== 0) {
    return occurrenceDiff;
  }

  const timeDiff = a.source.firstSeenSec - b.source.firstSeenSec;
  return timeDiff !== 0 ? timeDiff : a.order - b.order;
}

function clampSelectedIndex(index: number, items: ReviewedScore[]): number {
  if (items.length === 0) {
    return 0;
  }

  return Math.max(0, Math.min(index, items.length - 1));
}

function reviewTiming(item: ReviewedScore): string {
  return `${formatClock(item.score.source.firstSeenSec)} – ${formatClock(item.score.source.lastSeenSec)}`;
}

function repeatLabel(item: ReviewedScore): string {
  const repeatCount = item.repeatCount ?? (item.duplicateCount > 0 ? item.duplicateCount + 1 : 1);
  if (repeatCount <= 1) {
    return "반복 없음";
  }

  return `반복 ${item.repeatIndex ?? 1}/${repeatCount}`;
}

function previewStatus(response: PreviewState): string {
  const validationText = validationChangeText(response.validation);
  return validationText ? `미리보기 완료: ${response.pageCount}페이지, ${validationText}.` : `미리보기 완료: ${response.pageCount}페이지.`;
}

function validationLabel(item: ReviewedScore): string {
  const source = validationSourceLabel(item.validator);
  if (item.validationAction === "replaced") {
    return `${source}: 대체됨${item.replacementScoreId ? ` -> ${item.replacementScoreId}` : ""}`;
  }

  if (item.validationAction === "excluded") {
    return `${source}: 제외됨`;
  }

  return item.validationAction === "kept" ? `${source}: 통과` : "검토 대기";
}

function validationSourceLabel(validator: ReviewedScore["validator"]): string {
  return validator === "local" ? "로컬 검토" : "검토";
}

function formatClock(value: number): string {
  const totalSeconds = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function captureError(code: CaptureError["code"], message: string): CaptureError {
  return { code, message };
}

export {};
