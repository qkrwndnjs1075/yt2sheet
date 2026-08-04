import assert from "node:assert/strict";
import test from "node:test";
import { formatYtDlpProgress } from "../cli/yt-dlp-bootstrap";
import {
  createCliProgressReporter,
  createYtDlpProgressReporter,
  formatCliProgress
} from "../cli/progress";

test("formats the processing progress at each pipeline phase boundary", () => {
  assert.equal(formatCliProgress(0), "[1/6] 영상 정보 확인 0%");
  assert.equal(formatCliProgress(12), "[2/6] 영상 다운로드 12%");
  assert.equal(formatCliProgress(32), "[3/6] 프레임 추출 32%");
  assert.equal(formatCliProgress(45), "[4/6] 악보 프레임 분석 45%");
  assert.equal(formatCliProgress(75), "[5/6] 중복 악보 정리 75%");
  assert.equal(formatCliProgress(88), "[6/6] PDF 생성 88%");
  assert.equal(formatCliProgress(100), "[6/6] PDF 생성 100%");
});

test("emits one stable line per processing phase when output is not a TTY", () => {
  const output = createOutput(false);
  const reporter = createCliProgressReporter(output.stream);

  reporter.onProgress(0);
  reporter.onProgress(6);
  reporter.onProgress(12);
  reporter.onProgress(32);
  reporter.onProgress(45);
  reporter.onProgress(75);
  reporter.onProgress(88);
  reporter.onProgress(98);
  reporter.onProgress(100);
  reporter.finish();

  assert.deepEqual(output.chunks, [
    "[1/6] 영상 정보 확인 0%\n",
    "[2/6] 영상 다운로드 12%\n",
    "[3/6] 프레임 추출 32%\n",
    "[4/6] 악보 프레임 분석 45%\n",
    "[5/6] 중복 악보 정리 75%\n",
    "[6/6] PDF 생성 88%\n",
    "[6/6] PDF 생성 100%\n"
  ]);
});

test("redraws one processing line while output is an interactive TTY", () => {
  const output = createOutput(true);
  const reporter = createCliProgressReporter(output.stream);

  reporter.onProgress(0);
  reporter.onProgress(6);
  reporter.onProgress(12);
  reporter.finish();

  assert.deepEqual(output.chunks, [
    "\r\x1b[2K[1/6] 영상 정보 확인 0%",
    "\r\x1b[2K[1/6] 영상 정보 확인 6%",
    "\r\x1b[2K[2/6] 영상 다운로드 12%",
    "\r\x1b[2K\n"
  ]);
});

test("keeps yt-dlp bootstrap progress readable when output is piped", () => {
  const output = createOutput(false);
  const reporter = createYtDlpProgressReporter(output.stream);

  reporter.onProgress({ phase: "checking", percent: 0 });
  reporter.onProgress({ phase: "download", percent: 10, downloadedBytes: 10, totalBytes: 100 });
  reporter.onProgress({ phase: "download", percent: 100, downloadedBytes: 100, totalBytes: 100 });
  reporter.onProgress({ phase: "verify", percent: 100 });
  reporter.onProgress({ phase: "ready", percent: 100 });
  reporter.finish();

  assert.deepEqual(output.chunks, [
    `${formatYtDlpProgress({ phase: "checking", percent: 0 })}\n`,
    `${formatYtDlpProgress({ phase: "download", percent: 10, downloadedBytes: 10, totalBytes: 100 })}\n`,
    `${formatYtDlpProgress({ phase: "download", percent: 100, downloadedBytes: 100, totalBytes: 100 })}\n`,
    `${formatYtDlpProgress({ phase: "verify", percent: 100 })}\n`,
    `${formatYtDlpProgress({ phase: "ready", percent: 100 })}\n`
  ]);
});

function createOutput(isTTY: boolean): {
  readonly chunks: string[];
  readonly stream: { readonly isTTY: boolean; write(chunk: string): boolean };
} {
  const chunks: string[] = [];
  return {
    chunks,
    stream: {
      isTTY,
      write(chunk: string): boolean {
        chunks.push(chunk);
        return true;
      }
    }
  };
}
