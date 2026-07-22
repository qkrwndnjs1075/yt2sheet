import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildFrameExtractionArguments, buildVideoDownloadArguments } from "../server/youtube-score-processor";

describe("YouTube score frame extraction", () => {
  it("gives yt-dlp the configured ffmpeg path before requesting a merged MP4", () => {
    const args = buildVideoDownloadArguments("https://www.youtube.com/watch?v=video-id", "work", "tools/ffmpeg.exe");

    assert.equal(args[args.indexOf("--ffmpeg-location") + 1], "tools/ffmpeg.exe");
    assert.equal(args[args.indexOf("--merge-output-format") + 1], "mp4");
    assert.equal(args[args.indexOf("-o") + 1], "work\\source.%(ext)s");
  });

  it("lets yt-dlp resolve a bare ffmpeg command from PATH", () => {
    const args = buildVideoDownloadArguments("https://www.youtube.com/watch?v=video-id", "work", "ffmpeg");

    assert.equal(args.includes("--ffmpeg-location"), false);
  });

  it("keeps native frame resolution and samples a short video every half second", () => {
    const args = buildFrameExtractionArguments("source.mp4", "frames", 157);
    const filter = args[args.indexOf("-vf") + 1];
    const output = args.at(-1);

    assert.equal(filter, "fps=2");
    assert.equal(args.includes("scale=960:-2:force_original_aspect_ratio=decrease"), false);
    assert.equal(args[args.indexOf("-frames:v") + 1], "3600");
    assert.equal(args[args.indexOf("-q:v") + 1], "2");
    assert.equal(output, "frames\\frame-%06d.jpg");
  });
});
