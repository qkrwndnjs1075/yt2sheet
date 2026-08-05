import assert from "node:assert/strict";
import test from "node:test";
import { formatYtDlpProgress } from "../cli/yt-dlp-bootstrap";
import {
  createCliProgressReporter,
  createYtDlpProgressReporter,
  formatCliProgress
} from "../cli/progress";

test("formats the processing progress at each pipeline phase boundary", () => {
  assert.equal(formatCliProgress(0), "[1/9] info 0%");
  assert.equal(formatCliProgress(12), "[2/9] download 12%");
  assert.equal(formatCliProgress(32), "[3/9] extraction 32%");
  assert.equal(formatCliProgress(45), "[4/9] raster analysis 45%");
  assert.equal(formatCliProgress(75), "[5/9] raster review 75%");
  assert.equal(formatCliProgress(80), "[6/9] OMR 80%");
  assert.equal(formatCliProgress(85), "[7/9] MusicXML validation 85%");
  assert.equal(formatCliProgress(90), "[8/9] engraving 90%");
  assert.equal(formatCliProgress(98), "[9/9] PDF publication 98%");
  assert.equal(formatCliProgress(100), "[9/9] PDF publication 100%");
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
  reporter.onProgress(80);
  reporter.onProgress(85);
  reporter.onProgress(90);
  reporter.onProgress(98);
  reporter.onProgress(100);
  reporter.finish();

  assert.deepEqual(output.chunks, [
    "[1/9] info 0%\n",
    "[2/9] download 12%\n",
    "[3/9] extraction 32%\n",
    "[4/9] raster analysis 45%\n",
    "[5/9] raster review 75%\n",
    "[6/9] OMR 80%\n",
    "[7/9] MusicXML validation 85%\n",
    "[8/9] engraving 90%\n",
    "[9/9] PDF publication 98%\n",
    "[9/9] PDF publication 100%\n"
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
    "\r\x1b[2K[1/9] info 0%",
    "\r\x1b[2K[1/9] info 6%",
    "\r\x1b[2K[2/9] download 12%",
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

test("exposes the nine reviewed-output stages in order on piped stderr", () => {
  const output = createOutput(false);
  const reporter = createCliProgressReporter(output.stream);

  for (const progress of [0, 12, 32, 45, 75, 80, 85, 90, 98, 100]) reporter.onProgress(progress);
  reporter.finish();

  const labels = output.chunks.map((chunk) => chunk.replace(/\[\d+\/\d+\] /u, "").trim().replace(/ \d+%$/u, ""));
  assert.deepEqual(labels, [
    "info",
    "download",
    "extraction",
    "raster analysis",
    "raster review",
    "OMR",
    "MusicXML validation",
    "engraving",
    "PDF publication",
    "PDF publication"
  ]);
  assert.ok(output.chunks.every((chunk) => chunk.endsWith("\n")));
});

test("exposes every reviewed-output stage while redrawing a TTY line", () => {
  const output = createOutput(true);
  const reporter = createCliProgressReporter(output.stream);

  for (const progress of [0, 12, 32, 45, 75, 80, 85, 90, 98, 100]) reporter.onProgress(progress);
  reporter.finish();

  const labels = output.chunks
    .map((chunk) => chunk.match(/\] ([^\d]+?) \d+%/u)?.[1]?.trim())
    .filter((label): label is string => label !== undefined);
  assert.deepEqual(labels, [
    "info",
    "download",
    "extraction",
    "raster analysis",
    "raster review",
    "OMR",
    "MusicXML validation",
    "engraving",
    "PDF publication",
    "PDF publication"
  ]);
});

test("fills skipped stage callbacks when processor progress jumps", () => {
  const output = createOutput(false);
  const reporter = createCliProgressReporter(output.stream);

  reporter.onProgress(0);
  reporter.onProgress(45);
  reporter.onProgress(88);
  reporter.onProgress(100);

  const labels = output.chunks.map((chunk) => chunk.replace(/\[\d+\/\d+\] /u, "").trim().replace(/ \d+%$/u, ""));
  assert.deepEqual(labels, [
    "info",
    "download",
    "extraction",
    "raster analysis",
    "raster review",
    "OMR",
    "MusicXML validation",
    "engraving",
    "PDF publication"
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
