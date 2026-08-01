import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import ffmpegPath from "ffmpeg-static";
import sharp from "sharp";
import { runProcess } from "../pipeline/media-tools";
import { resolveScoreTimeRange } from "../pipeline/score-time-range";
import { buildFrameExtractionArguments } from "../pipeline/youtube-score-processor";

it("extracts only the requested half-open color range with bundled FFmpeg", async (t) => {
  // Given: a real four-second video containing one second each of red, green, blue, and yellow.
  assert.ok(ffmpegPath, "ffmpeg-static must provide a binary for this machine");
  const workDirectory = await mkdtemp(join(tmpdir(), "yt2sheet-ffmpeg-range-"));
  const videoPath = join(workDirectory, "colors.mp4");
  const frameDirectory = join(workDirectory, "frames");
  await mkdir(frameDirectory);
  t.after(async () => rm(workDirectory, { recursive: true, force: true }));
  await runProcess(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=red:s=32x32:r=2:d=1",
    "-f", "lavfi", "-i", "color=c=green:s=32x32:r=2:d=1",
    "-f", "lavfi", "-i", "color=c=blue:s=32x32:r=2:d=1",
    "-f", "lavfi", "-i", "color=c=yellow:s=32x32:r=2:d=1",
    "-filter_complex", "[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0,format=yuv420p[v]",
    "-map", "[v]", videoPath
  ], { timeoutMs: 30_000 });
  const timeRange = resolveScoreTimeRange({ startTimeSec: 1, endTimeSec: 3 }, 4);
  if (timeRange.kind === "invalid") assert.fail(`fixture range failed to resolve: ${timeRange.reason}`);

  // When: the production extraction arguments drive the bundled FFmpeg binary.
  await runProcess(
    ffmpegPath,
    buildFrameExtractionArguments(videoPath, frameDirectory, timeRange),
    { timeoutMs: 30_000 }
  );

  // Then: [1,3) produces exactly four 2fps frames whose pixels are only green then blue.
  const frames = (await readdir(frameDirectory)).sort();
  const colors = await Promise.all(frames.map(async (frame) => {
    const pixel = await sharp(join(frameDirectory, frame)).resize(1, 1).removeAlpha().raw().toBuffer();
    if (pixel[1] > pixel[0] && pixel[1] > pixel[2]) return "green";
    if (pixel[2] > pixel[0] && pixel[2] > pixel[1]) return "blue";
    return "other";
  }));
  assert.equal(frames.length, 4);
  assert.deepEqual(colors, ["green", "green", "blue", "blue"]);
  t.diagnostic(JSON.stringify({ range: "[1,3)", fps: 2, frameCount: frames.length, colors }));
});
