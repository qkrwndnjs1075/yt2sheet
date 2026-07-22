import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const contentScriptSources = ["src/content/roi-selector.ts", "src/content/video-probe.ts"];

test("dynamically injected content scripts do not use runtime imports", () => {
  for (const sourcePath of contentScriptSources) {
    const source = readFileSync(resolve(process.cwd(), sourcePath), "utf8");
    const runtimeImports = source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^import(?!\s+type\b)/.test(line));

    assert.deepEqual(runtimeImports, [], `${sourcePath} must stay self-contained for chrome.scripting.executeScript`);
  }
});

test("video probe suppresses transient YouTube controls only while capture is active", () => {
  const source = readFileSync(resolve(process.cwd(), "src/content/video-probe.ts"), "utf8");
  const startProbe = source.slice(source.indexOf("function startProbe"), source.indexOf("function stopProbe"));
  const stopCurrentProbe = source.slice(source.indexOf("function stopCurrentProbe"), source.indexOf("function sendTick"));

  assert.match(source, /\.ytp-chrome-bottom/);
  assert.match(source, /\.ytp-gradient-bottom/);
  assert.match(source, /\.ytp-tooltip/);
  assert.match(source, /\.ytp-bezel/);
  assert.match(startProbe, /suppressPlayerOverlays\(\);[\s\S]*sendTick\(\)/);
  assert.match(stopCurrentProbe, /restorePlayerOverlays\(\)/);
});

test("ROI selector carries inline fallback styles for visible programmatic injection", () => {
  const source = readFileSync(resolve(process.cwd(), "src/content/roi-selector.ts"), "utf8");

  assert.match(source, /applySelectorInlineStyles\(overlay, selection, toolbar, useButton, cancelButton\)/);
  assert.match(source, /function applySelectorInlineStyles/);
  assert.match(source, /position: "fixed"/);
  assert.match(source, /zIndex: "2147483647"/);
});

test("export review loads hydrated images through the background instead of compact session storage", () => {
  const source = readFileSync(resolve(process.cwd(), "src/content/roi-selector.ts"), "utf8");
  const backgroundSource = readFileSync(resolve(process.cwd(), "src/background/index.ts"), "utf8");

  assert.match(source, /showExportReviewPanel\(message\)/);
  assert.doesNotMatch(source, /showExportPanel\(message\)/);
  assert.doesNotMatch(source, /function showExportPanel/);
  assert.doesNotMatch(source, /loadExportReviewDataFromSessionStorage/);
  assert.doesNotMatch(source, /chrome\.storage\.session\.get\(DEBUG_CAPTURE_STATE_KEY\)/);
  assert.match(source, /GET_EXPORT_REVIEW_DATA/);
  assert.match(source, /VALIDATE_EXPORT_REVIEW/);
  assert.doesNotMatch(backgroundSource, /chrome\.storage\.session\.setAccessLevel/);
  assert.doesNotMatch(backgroundSource, /TRUSTED_AND_UNTRUSTED_CONTEXTS/);
  assert.match(backgroundSource, /validateExportReview/);
  assert.match(source, /selectedReviewOrder\(reviewedScores\)/);
  assert.match(source, /occurrenceOrder/);
  assert.match(source, /scoreOrder/);
  assert.match(source, /PREVIEW_SCORE_EXPORT/);
  assert.match(source, /exportCompleteStatus/);
  assert.match(source, /reviewValidationStatus/);
  assert.match(source, /status\.setAttribute\("role", "status"\)/);
  assert.match(source, /applyValidationDetails/);
  assert.match(source, /validation\.replacedCount/);
  assert.match(source, /validation\.excludedCount/);
  assert.match(source, /validationDetails/);
  assert.match(source, /replacementScoreId/);
  assert.match(source, /checkbox\.disabled = item\.validationAction === "excluded"/);
  assert.match(source, /validationSourceLabel/);
  assert.match(source, /pdfButton\.disabled = [^;]*!previewApproved/);
  assert.match(source, /pngButton\.disabled = [^;]*!previewApproved/);
  assert.match(source, /pages: previewState\.pages/);
  assert.doesNotMatch(source, /status\.textContent = `\$\{response\.downloadCount\}개 파일 다운로드를 시작했습니다\.`/);
});

test("review panel is occurrence-aware and requires approval of the current preview before export", () => {
  const source = readFileSync(resolve(process.cwd(), "src/content/roi-selector.ts"), "utf8");

  assert.doesNotMatch(source, /loadExportReviewDataFromSessionStorage/);
  assert.match(source, /occurrenceOrder/);
  assert.doesNotMatch(source, /\.map\(\(item\) => item\.score\.clusterId\)/);
  assert.match(source, /score-export-panel__selected-score/);
  assert.match(source, /score-export-panel__occurrence-list/);
  assert.match(source, /score-export-panel__comparison-strip/);
  assert.match(source, /score-export-panel__preview-panel/);
  assert.match(source, /score-export-panel__summary/);
  assert.match(source, /renderReviewSummary/);
  assert.match(source, /summarizeReview/);
  assert.match(source, /score-export-panel__state--included/);
  assert.match(source, /PREVIEW_SCORE_EXPORT/);
  assert.match(source, /score-export-panel__preview-approval/);
  assert.match(source, /previewApproved = false/);
});

test("review panel CSS keeps dense plugin UI accessible in small viewports", () => {
  const css = readFileSync(resolve(process.cwd(), "src/content/roi-selector.css"), "utf8");

  assert.match(css, /\.score-export-panel \{[\s\S]*max-height: calc\(100dvh - 48px\)/);
  assert.match(css, /@media \(max-width: 520px\) \{[\s\S]*max-height: calc\(100dvh - 24px\)/);
  assert.match(css, /\.score-export-panel__summary/);
  assert.match(css, /:focus-visible/);
});

test("review images expose one accessible zoom viewer across score and page surfaces", () => {
  const source = readFileSync(resolve(process.cwd(), "src/content/roi-selector.ts"), "utf8");
  const css = readFileSync(resolve(process.cwd(), "src/content/roi-selector.css"), "utf8");

  assert.match(source, /function openImageViewer/);
  assert.match(source, /score-image-viewer/);
  assert.match(source, /setAttribute\("role", "dialog"\)/);
  assert.match(source, /setAttribute\("aria-modal", "true"\)/);
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /event\.key === "0"/);
  assert.match(source, /openImageViewer\(image\.src, image\.alt\)/);
  assert.match(css, /\.score-export-panel \{[\s\S]*width: 760px/);
  assert.match(css, /\.score-image-viewer__stage \{[\s\S]*overflow: auto/);
  assert.match(css, /\.score-image-viewer__image/);
  assert.match(css, /\.score-export-panel__selected-score img \{[\s\S]*max-height: 320px/);
  assert.doesNotMatch(css, /\.score-export-panel__preview-page img \{[\s\S]*max-height: 260px/);
});

test("background score export wiring supports occurrence preview before download", () => {
  const messagesSource = readFileSync(resolve(process.cwd(), "src/shared/messages.ts"), "utf8");
  const backgroundSource = readFileSync(resolve(process.cwd(), "src/background/index.ts"), "utf8");
  const previewStart = backgroundSource.indexOf("async function previewScoreExport");
  const previewEnd = backgroundSource.indexOf("async function exportScoreCapture");
  const previewSource = previewStart >= 0 && previewEnd > previewStart ? backgroundSource.slice(previewStart, previewEnd) : "";

  assert.match(messagesSource, /PREVIEW_SCORE_EXPORT/);
  assert.match(messagesSource, /PreviewScoreExportPage/);
  assert.match(messagesSource, /PreviewScoreExportResponse/);
  assert.match(messagesSource, /pages: PreviewScoreExportPage\[\]/);
  assert.match(messagesSource, /pageIndex: number/);
  assert.match(messagesSource, /dataUrl: string/);
  assert.match(messagesSource, /EXPORT_SCORE_CAPTURE[^\n]*pages: PreviewScoreExportPage\[\]/);
  assert.match(backgroundSource, /message\.type === "PREVIEW_SCORE_EXPORT"/);
  assert.match(backgroundSource, /previewScoreExport\(message\)/);
  assert.match(backgroundSource, /exportOccurrences: frame\.exportOccurrences \?\? state\.exportOccurrences/);
  assert.match(backgroundSource, /pageCount: packScorePages\(scores\)\.length/);
  assert.match(backgroundSource, /pageLayout: SCORE_IDENTITY_CONFIG\.page/);
  assert.match(backgroundSource, /const reviewScores = reviewScoresForExport\(state\)/);
  assert.match(backgroundSource, /validateExportScores\(reviewScores,\s*\{[\s\S]*occurrenceOrder: message\.occurrenceOrder/);
  const exportSource = backgroundSource.slice(previewEnd);
  assert.match(exportSource, /exportApprovedPreviewAsPdf\(message\.pages\)/);
  assert.match(exportSource, /previewPageBlobs\(message\.pages\)/);
  assert.doesNotMatch(exportSource, /validateExportScores\(/);
  assert.doesNotMatch(backgroundSource, /validatedScores\.map\(\(score\) => score\.clusterId\)/);
  assert.match(previewSource, /exportScoresAsPngPages\(validatedScores,\s*exportOptions\)/);
  assert.match(previewSource, /blobToDataUrl/);
  assert.match(previewSource, /pages: pageDataUrls\.map\(\(dataUrl, pageIndex\) => \(\{ pageIndex, dataUrl \}\)\)/);
  assert.doesNotMatch(previewSource, /chrome\.downloads\.download/);
  assert.doesNotMatch(previewSource, /downloadBlob\(/);
});

test("Vite wraps dynamically injected content script bundles for repeated injection", () => {
  const source = readFileSync(resolve(process.cwd(), "vite.config.ts"), "utf8");

  assert.match(source, /src\/content\/roi-selector\.js/);
  assert.match(source, /src\/content\/video-probe\.js/);
  assert.match(source, /function wrapContentScripts/);
  assert.match(source, /`\(\(\) => \{\\n\$\{code\}\\n\}\)\(\);\\n`/);
});
