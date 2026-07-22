import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

test("tab capture stream id is acquired before ROI selection waits on the page", () => {
  const source = readFileSync(resolve(process.cwd(), "src/background/index.ts"), "utf8");
  const streamIdIndex = source.indexOf("const streamId = await getTabMediaStreamId(tab.id);");
  const roiIndex = source.indexOf("const roiConfig = await selectScoreRoi");

  assert.notEqual(streamIdIndex, -1);
  assert.notEqual(roiIndex, -1);
  assert.ok(streamIdIndex < roiIndex, "getMediaStreamId must run inside the action-click user gesture window before ROI selection");
});

test("offscreen capture startup retries once with a fresh stream id", () => {
  const source = readFileSync(resolve(process.cwd(), "src/background/index.ts"), "utf8");

  assert.match(source, /async function startOffscreenCapture/);
  assert.match(source, /firstError\.code !== "GET_USER_MEDIA_FAILED"/);
  assert.match(source, /const retryStreamId = await getTabMediaStreamId\(tabId\);/);
  assert.match(source, /const retryResponse = await sendStartCapture\(session, retryStreamId\);/);
});

test("export review data is served by the background context", () => {
  const backgroundSource = readFileSync(resolve(process.cwd(), "src/background/index.ts"), "utf8");
  const messageSource = readFileSync(resolve(process.cwd(), "src/shared/messages.ts"), "utf8");

  assert.match(messageSource, /GET_EXPORT_REVIEW_DATA/);
  assert.match(messageSource, /ExportReviewDataResponse/);
  assert.match(backgroundSource, /message\.type === "GET_EXPORT_REVIEW_DATA"/);
  assert.match(backgroundSource, /async function getExportReviewData/);
  assert.match(
    backgroundSource,
    /return\s+\{\s*ok:\s*true,\s*scores:\s*state\.uniqueScores,\s*exportOccurrences:\s*state\.exportOccurrences,\s*exportCandidates:\s*state\.exportCandidates\s*\}/
  );
});

test("capture events wait for serialized background persistence before acknowledging delivery", () => {
  const backgroundSource = readFileSync(resolve(process.cwd(), "src/background/index.ts"), "utf8");
  const sinkSource = readFileSync(resolve(process.cwd(), "src/offscreen/debug-frame-sink.ts"), "utf8");

  assert.match(backgroundSource, /isBackgroundCaptureEvent\(message\)/);
  assert.match(backgroundSource, /void enqueueCaptureMessage\(message\)\.then\(sendResponse\)/);
  assert.match(backgroundSource, /captureMessageQueue = captureMessageQueue\.then\(\(\) => handleRuntimeMessage\(message\)\)/);
  assert.match(sinkSource, /const response = await chrome\.runtime\.sendMessage<RuntimeMessage, CaptureCommandResponse>\(outbound\.message\)/);
  assert.match(sinkSource, /if \(!response\?\.ok\)/);
});

test("offscreen start getUserMedia failures do not emit duplicate capture errors", () => {
  const source = readFileSync(resolve(process.cwd(), "src/offscreen/frame-input-collector.ts"), "utf8");
  const startCatch = source.slice(source.indexOf("async start("), source.indexOf("async stop("));

  assert.doesNotMatch(startCatch, /onError\(captureError\("GET_USER_MEDIA_FAILED"/);
});

test("offscreen close ignores already-closed cleanup races", () => {
  const source = readFileSync(resolve(process.cwd(), "src/background/offscreen-manager.ts"), "utf8");

  assert.match(source, /isNoCurrentOffscreenDocumentError/);
  assert.match(source, /No current offscreen document/i);
});

test("ROI selection cancellation is treated as a normal user stop", () => {
  const source = readFileSync(resolve(process.cwd(), "src/background/index.ts"), "utf8");
  const cancellationBranch = source.indexOf('normalized.code === "ROI_SELECTION_CANCELLED"');
  const errorRecording = source.indexOf("await recordDebugError(normalized);");

  assert.notEqual(cancellationBranch, -1);
  assert.notEqual(errorRecording, -1);
  assert.ok(cancellationBranch < errorRecording, "ROI cancellation should return before recording an action-click failure");
  assert.match(source, /logger\.info\("ROI selection cancelled\."\)/);
});
