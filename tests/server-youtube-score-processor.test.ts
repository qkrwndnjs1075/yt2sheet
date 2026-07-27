import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { ScoreJobProcessorContext } from "../server/score-job-service";
import { buildFrameExtractionArguments, buildVideoDownloadArguments, YouTubeScoreProcessor } from "../server/youtube-score-processor";

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

describe("YouTube score cancellation", () => {
  it("retries one HTTP 403 download with the current YouTube player JavaScript", async (t) => {
    const dataRoot = await createTempDirectory(t, "yt2sheet-youtube-403-");
    const downloadArguments: (readonly string[])[] = [];
    let downloadAttempts = 0;
    const processor = new YouTubeScoreProcessor({
      dataRoot,
      tools: { ytDlp: "yt-dlp-test", ffmpeg: "ffmpeg-test", ffprobe: "ffprobe-test" },
      processRunner: async (executable, args) => {
        if (executable === "yt-dlp-test" && args.includes("--skip-download")) return "60";
        if (executable === "yt-dlp-test") {
          downloadArguments.push(args);
          downloadAttempts += 1;
          if (downloadAttempts === 1) {
            throw new Error("yt-dlp failed: ERROR: unable to download video data: HTTP Error 403: Forbidden");
          }
          return args[args.indexOf("-o") + 1]?.replace("%(ext)s", "mp4") ?? "";
        }
        if (executable === "ffprobe-test") return "60";
        return "";
      },
      frameLister: async () => ["frame.png"],
      pdfCreator: async (_frames, _workspace, outputPath) => {
        await writeFile(outputPath, "%PDF-test");
        return { pageCount: 1, scoreCount: 1 };
      }
    });

    await processor.process(jobInput(), createContext(new AbortController().signal));

    assert.equal(downloadArguments.length, 2);
    assert.equal(downloadArguments[0]?.includes("--extractor-args"), false);
    const playerArgumentIndex = downloadArguments[1]?.indexOf("--extractor-args") ?? -1;
    assert.equal(downloadArguments[1]?.[playerArgumentIndex + 1], "youtube:player_js_version=actual");
  });

  it("does not retry a non-403 downloader failure", async (t) => {
    const dataRoot = await createTempDirectory(t, "yt2sheet-youtube-download-error-");
    let downloadAttempts = 0;
    const processor = new YouTubeScoreProcessor({
      dataRoot,
      tools: { ytDlp: "yt-dlp-test", ffmpeg: "ffmpeg-test", ffprobe: "ffprobe-test" },
      processRunner: async (executable, args) => {
        if (executable === "yt-dlp-test" && args.includes("--skip-download")) return "60";
        if (executable === "yt-dlp-test") {
          downloadAttempts += 1;
          throw new Error("yt-dlp failed: network unavailable");
        }
        return "";
      }
    });

    await assert.rejects(processor.process(jobInput(), createContext(new AbortController().signal)), {
      code: "MEDIA_PROCESSING_FAILED"
    });
    assert.equal(downloadAttempts, 1);
  });

  it("passes injected creation time into a retained owned result", async (t) => {
    // Given: deterministic media stages, clock, and PDF writer.
    const dataRoot = await createTempDirectory(t, "yt2sheet-youtube-success-");
    const createdAt = new Date("2026-07-24T03:04:05.000Z");
    let observedOptions: ObservedPdfOptions | undefined;
    const processor = new YouTubeScoreProcessor({
      dataRoot,
      tools: { ytDlp: "yt-dlp-test", ffmpeg: "ffmpeg-test", ffprobe: "ffprobe-test" },
      clock: () => createdAt,
      processRunner: createProcessRunner(),
      frameLister: async () => ["frame.png"],
      pdfCreator: async (_frames: readonly string[], _workspace: string, outputPath: string, options: ObservedPdfOptions) => {
        observedOptions = options;
        await writeFile(outputPath, "%PDF-test");
        return { pageCount: 2, scoreCount: 3 };
      }
    });

    // When: a job completes through every processing stage.
    const result = await processor.process(jobInput(), createContext(new AbortController().signal));

    // Then: the final options and result capability carry the owned contract.
    assert.ok(observedOptions);
    assert.equal(observedOptions.metadata.videoId, "video-id");
    assert.equal(observedOptions.metadata.createdAt, createdAt);
    assert.match(basename(result.filePath), /^yt2sheet-result-p[1-9][0-9]*-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pdf$/i);
    assert.deepEqual(await readdir(join(dataRoot, "results")), [basename(result.filePath)]);
  });

  it("removes only the owned output when cancellation arrives after its write", async (t) => {
    // Given: a PDF stage that writes the owned file and then cancels the job.
    const dataRoot = await createTempDirectory(t, "yt2sheet-youtube-abort-");
    const controller = new AbortController();
    const sentinelName = "not-owned.pdf";
    const processor = new YouTubeScoreProcessor({
      dataRoot,
      tools: { ytDlp: "yt-dlp-test", ffmpeg: "ffmpeg-test", ffprobe: "ffprobe-test" },
      clock: () => new Date("2026-07-24T03:04:05.000Z"),
      processRunner: createProcessRunner(),
      frameLister: async () => ["frame.png"],
      pdfCreator: async (_frames: readonly string[], _workspace: string, outputPath: string) => {
        await Promise.all([
          writeFile(outputPath, "%PDF-cancelled"),
          writeFile(join(dataRoot, "results", sentinelName), "keep")
        ]);
        controller.abort();
        return { pageCount: 1, scoreCount: 1 };
      }
    });

    // When: processing resumes after the cancelled PDF write.
    const result = processor.process(jobInput(), createContext(controller.signal));

    // Then: AbortError escapes unchanged and only the owned result is removed.
    await assert.rejects(result, { name: "AbortError" });
    assert.deepEqual(await readdir(join(dataRoot, "results")), [sentinelName]);
  });

  it("does not start media acquisition for a pre-aborted job", async (t) => {
    // Given: a processor whose media runner records calls and an aborted signal.
    const dataRoot = await createTempDirectory(t, "yt2sheet-youtube-pre-abort-");
    const controller = new AbortController();
    let processCalls = 0;
    controller.abort();
    const processor = new YouTubeScoreProcessor({
      dataRoot,
      processRunner: async () => {
        processCalls += 1;
        return "";
      }
    });

    // When: the cancelled job is submitted to the processor.
    const result = processor.process(jobInput(), createContext(controller.signal));

    // Then: it remains AbortError and no external process begins.
    await assert.rejects(result, { name: "AbortError" });
    assert.equal(processCalls, 0);
  });
});

type ObservedPdfOptions = {
  readonly onProgress?: (progress: number) => void;
  readonly signal?: AbortSignal;
  readonly metadata: { readonly videoId: string; readonly createdAt: Date };
};

type ObservedRunOptions = {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
};

function createProcessRunner(): (executable: string, args: readonly string[], options?: ObservedRunOptions) => Promise<string> {
  return async (executable, args) => {
    if (executable === "yt-dlp-test" && args.includes("--skip-download")) return "60";
    if (executable === "yt-dlp-test") {
      const outputTemplate = args[args.indexOf("-o") + 1];
      return outputTemplate.replace("%(ext)s", "mp4");
    }
    if (executable === "ffprobe-test") return "60";
    return "";
  };
}

function jobInput() {
  return {
    videoId: "video-id",
    videoUrl: "https://www.youtube.com/watch?v=video-id"
  };
}

function createContext(signal: AbortSignal): ScoreJobProcessorContext {
  const onProgress = (_progress: number): void => undefined;
  return Object.assign(onProgress, { onProgress, signal });
}

async function createTempDirectory(t: TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    t.diagnostic(JSON.stringify({ directory, tempRemoved: true }));
  });
  return directory;
}
