import assert from "node:assert/strict";
import fs, { type PathLike } from "node:fs";
import { lstat, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { createScoreExtractionQualityReport, deriveScoreQualitySidecarPath, type ScoreExtractionQualityReport } from "../server/score-quality-report";
import { ScorePipelineError, type ScoreJobProcessorContext } from "../server/score-job-service";
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

  it("enables the Node JavaScript runtime for yt-dlp extraction", () => {
    const args = buildVideoDownloadArguments("https://www.youtube.com/watch?v=video-id", "work", "ffmpeg", {
      ytDlpCookiesPath: "/run/secrets/youtube-cookies.txt"
    });

    assert.deepEqual(args.slice(0, 4), ["--js-runtimes", "node", "--cookies", "/run/secrets/youtube-cookies.txt"]);
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

  it("surfaces a YouTube 429 bot challenge without retrying it", async (t) => {
    const dataRoot = await createTempDirectory(t, "yt2sheet-youtube-429-");
    let downloadAttempts = 0;
    const processor = new YouTubeScoreProcessor({
      dataRoot,
      tools: { ytDlp: "yt-dlp-test", ffmpeg: "ffmpeg-test", ffprobe: "ffprobe-test" },
      processRunner: async (executable, args) => {
        if (executable === "yt-dlp-test" && args.includes("--skip-download")) return "60";
        if (executable === "yt-dlp-test") {
          downloadAttempts += 1;
          throw new Error("yt-dlp failed: HTTP Error 429: Too Many Requests\nSign in to confirm you're not a bot");
        }
        return "";
      }
    });

    await assert.rejects(processor.process(jobInput(), createContext(new AbortController().signal)), (error: unknown) => {
      return error instanceof ScorePipelineError
        && error.code === "YOUTUBE_ACCESS_BLOCKED"
        && /차단/.test(error.publicMessage);
    });
    assert.equal(downloadAttempts, 1);
  });

  it("persists a parseable quality sidecar while returning only the PDF result contract", async (t) => {
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
        assert.ok(options.qualityReportSink);
        await options.qualityReportSink(qualityReport());
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
    assert.deepEqual(result, { filePath: result.filePath, pageCount: 2 });
    assert.equal((await readFile(result.filePath)).subarray(0, 5).toString(), "%PDF-");
    assert.deepEqual(JSON.parse(await readFile(deriveScoreQualitySidecarPath(result.filePath), "utf8")), qualityReport());
    assert.deepEqual(await readdir(join(dataRoot, "results")), [
      basename(result.filePath),
      basename(deriveScoreQualitySidecarPath(result.filePath))
    ]);
  });

  it("removes the owned pair when cancellation arrives after both writes", async (t) => {
    // Given: a PDF stage that writes the owned pair and then cancels the job.
    const dataRoot = await createTempDirectory(t, "yt2sheet-youtube-abort-");
    const controller = new AbortController();
    const sentinelName = "not-owned.pdf";
    const processor = new YouTubeScoreProcessor({
      dataRoot,
      tools: { ytDlp: "yt-dlp-test", ffmpeg: "ffmpeg-test", ffprobe: "ffprobe-test" },
      clock: () => new Date("2026-07-24T03:04:05.000Z"),
      processRunner: createProcessRunner(),
      frameLister: async () => ["frame.png"],
      pdfCreator: async (_frames: readonly string[], _workspace: string, outputPath: string, options: ObservedPdfOptions) => {
        await Promise.all([
          writeFile(outputPath, "%PDF-cancelled"),
          writeFile(join(dataRoot, "results", sentinelName), "keep")
        ]);
        assert.ok(options.qualityReportSink);
        await options.qualityReportSink(qualityReport());
        assert.equal(JSON.parse(await readFile(deriveScoreQualitySidecarPath(outputPath), "utf8")).version, "score-extraction-quality-report/1");
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

  it("removes the owned PDF when cancellation arrives after its write but before the sidecar sink", async (t) => {
    // Given: the real PDF stage's post-write cancellation boundary before report persistence.
    const dataRoot = await createTempDirectory(t, "yt2sheet-youtube-post-write-abort-");
    const controller = new AbortController();
    const sentinelName = "not-owned.pdf";
    const processor = new YouTubeScoreProcessor({
      dataRoot,
      tools: { ytDlp: "yt-dlp-test", ffmpeg: "ffmpeg-test", ffprobe: "ffprobe-test" },
      processRunner: createProcessRunner(),
      frameLister: async () => ["frame.png"],
      pdfCreator: async (_frames: readonly string[], _workspace: string, outputPath: string, options: ObservedPdfOptions) => {
        await Promise.all([
          writeFile(outputPath, "%PDF-cancelled-before-sidecar"),
          writeFile(join(dataRoot, "results", sentinelName), "keep")
        ]);
        assert.ok(options.outputArtifactSink);
        await options.outputArtifactSink();
        controller.abort();
        throw new DOMException("The operation was aborted.", "AbortError");
      }
    });

    // When: cancellation occurs at the PDF writer's first post-write guard.
    const result = processor.process(jobInput(), createContext(controller.signal));

    // Then: the captured owned PDF is removed without touching the unrelated sentinel.
    await assert.rejects(result, { name: "AbortError" });
    assert.deepEqual(await readdir(join(dataRoot, "results")), [sentinelName]);
  });

  it("preserves replacement PDF, sidecar, and temporary files after cancellation", async (t) => {
    // Given: every owned artifact is replaced by a different regular file after its successful write.
    const dataRoot = await createTempDirectory(t, "yt2sheet-youtube-replacement-race-");
    const controller = new AbortController();
    const observations = new Map<string, ArtifactObservation>();
    let temporaryPath: string | null = null;
    const processor = new YouTubeScoreProcessor({
      dataRoot,
      tools: { ytDlp: "yt-dlp-test", ffmpeg: "ffmpeg-test", ffprobe: "ffprobe-test" },
      processRunner: createProcessRunner(),
      frameLister: async () => ["frame.png"],
      sidecarWriter: async (path, contents) => {
        temporaryPath = path;
        await writeFile(path, contents, { flag: "wx" });
        observations.set("temporary", await observeArtifact(path));
      },
      sidecarRenamer: async (sourcePath, destinationPath) => {
        await rename(sourcePath, destinationPath);
        observations.set("sidecar", await observeArtifact(destinationPath));
        await writeFile(sourcePath, "replacement-temporary", { flag: "wx" });
      },
      pdfCreator: async (_frames: readonly string[], _workspace: string, outputPath: string, options: ObservedPdfOptions) => {
        await writeFile(outputPath, "%PDF-owned");
        observations.set("pdf", await observeArtifact(outputPath));
        assert.ok(options.qualityReportSink);
        await options.qualityReportSink(qualityReport());
        const sidecarPath = deriveScoreQualitySidecarPath(outputPath);
        await Promise.all([
          rename(outputPath, `${outputPath}.owned-original`),
          rename(sidecarPath, `${sidecarPath}.owned-original`)
        ]);
        await Promise.all([
          writeFile(outputPath, "%PDF-replacement"),
          writeFile(sidecarPath, "replacement-sidecar")
        ]);
        controller.abort();
        return { pageCount: 1, scoreCount: 1 };
      }
    });

    // When: cancellation reaches processor cleanup after all pathname replacements.
    const result = processor.process(jobInput(), createContext(controller.signal));

    // Then: each replacement has a different identity and survives with its sentinel content.
    await assert.rejects(result, { name: "AbortError" });
    assert.ok(temporaryPath);
    const pdfObservation = observations.get("pdf");
    const sidecarObservation = observations.get("sidecar");
    assert.ok(pdfObservation);
    assert.ok(sidecarObservation);
    const replacementPaths = {
      pdf: pdfObservation.path,
      sidecar: sidecarObservation.path,
      temporary: temporaryPath
    };
    for (const [kind, path] of Object.entries(replacementPaths)) {
      assert.ok(path);
      const original = observations.get(kind);
      assert.ok(original);
      const replacement = await lstat(path, { bigint: true });
      assert.equal(replacement.isFile(), true);
      assert.equal(replacement.isSymbolicLink(), false);
      assert.notDeepEqual([replacement.dev, replacement.ino], [original.device, original.inode]);
      t.diagnostic(JSON.stringify({
        artifact: kind,
        original: { dev: original.device.toString(), ino: original.inode.toString() },
        replacement: { dev: replacement.dev.toString(), ino: replacement.ino.toString() },
        content: await readFile(path, "utf8")
      }));
    }
    assert.equal(await readFile(replacementPaths.pdf, "utf8"), "%PDF-replacement");
    assert.equal(await readFile(replacementPaths.sidecar, "utf8"), "replacement-sidecar");
    assert.equal(await readFile(replacementPaths.temporary, "utf8"), "replacement-temporary");
  });

  it("preserves AbortError when identity cleanup itself fails", async (t) => {
    // Given: a cancelled completed write whose identity recheck raises a filesystem error.
    const dataRoot = await createTempDirectory(t, "yt2sheet-youtube-cleanup-error-");
    const controller = new AbortController();
    let outputPath: string | null = null;
    let outputLstatCalls = 0;
    const originalLstat = fs.promises.lstat.bind(fs.promises);
    t.mock.method(fs.promises, "lstat", async (path: PathLike) => {
      if (typeof path === "string" && path === outputPath) {
        outputLstatCalls += 1;
        if (outputLstatCalls === 2) throw new Error("injected cleanup lstat failure");
      }
      return originalLstat(path);
    });
    const processor = new YouTubeScoreProcessor({
      dataRoot,
      tools: { ytDlp: "yt-dlp-test", ffmpeg: "ffmpeg-test", ffprobe: "ffprobe-test" },
      processRunner: createProcessRunner(),
      frameLister: async () => ["frame.png"],
      pdfCreator: async (_frames: readonly string[], _workspace: string, createdOutputPath: string, options: ObservedPdfOptions) => {
        outputPath = createdOutputPath;
        await writeFile(createdOutputPath, "%PDF-owned");
        assert.ok(options.qualityReportSink);
        await options.qualityReportSink(qualityReport());
        controller.abort();
        return { pageCount: 1, scoreCount: 1 };
      }
    });

    // When: cancellation cleanup encounters the injected identity-check failure.
    const result = processor.process(jobInput(), createContext(controller.signal));

    // Then: cleanup was attempted without replacing the original AbortError.
    await assert.rejects(result, { name: "AbortError" });
    assert.equal(outputLstatCalls, 2);
    assert.ok(outputPath);
    assert.equal(await readFile(outputPath, "utf8"), "%PDF-owned");
  });

  const sidecarFailures = ["write", "rename"] satisfies readonly ("write" | "rename")[];
  for (const failure of sidecarFailures) {
    it(`removes the owned PDF, sidecar, and temporary file when sidecar ${failure} fails`, async (t) => {
      // Given: a completed PDF and an injected atomic-sidecar failure.
      const dataRoot = await createTempDirectory(t, `yt2sheet-youtube-sidecar-${failure}-`);
      const sentinelName = "not-owned.json";
      const processor = new YouTubeScoreProcessor({
        dataRoot,
        tools: { ytDlp: "yt-dlp-test", ffmpeg: "ffmpeg-test", ffprobe: "ffprobe-test" },
        processRunner: createProcessRunner(),
        frameLister: async () => ["frame.png"],
        sidecarWriter: failure === "write" ? async () => {
          throw new Error("injected sidecar write failure");
        } : undefined,
        sidecarRenamer: failure === "rename" ? async (sourcePath, destinationPath) => {
          assert.equal(dirname(sourcePath), dirname(destinationPath));
          assert.equal(JSON.parse(await readFile(sourcePath, "utf8")).version, "score-extraction-quality-report/1");
          throw new Error("injected sidecar rename failure");
        } : undefined,
        pdfCreator: async (_frames: readonly string[], _workspace: string, outputPath: string, options: ObservedPdfOptions) => {
          await Promise.all([
            writeFile(outputPath, "%PDF-failed-sidecar"),
            writeFile(join(dataRoot, "results", sentinelName), "keep")
          ]);
          assert.ok(options.qualityReportSink);
          await options.qualityReportSink(qualityReport());
          return { pageCount: 1, scoreCount: 1 };
        }
      });

      // When: the report sink cannot complete its atomic write.
      const result = processor.process(jobInput(), createContext(new AbortController().signal));

      // Then: the ordinary pipeline error remains and no owned artifact survives.
      await assert.rejects(result, { code: "MEDIA_PROCESSING_FAILED" });
      assert.deepEqual(await readdir(join(dataRoot, "results")), [sentinelName]);
    });
  }

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
  readonly outputArtifactSink?: () => Promise<void>;
  readonly qualityReportSink?: (report: ScoreExtractionQualityReport) => Promise<void>;
  readonly metadata: { readonly videoId: string; readonly createdAt: Date };
};

type ArtifactObservation = {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
};

async function observeArtifact(path: string): Promise<ArtifactObservation> {
  const stats = await lstat(path, { bigint: true });
  assert.equal(stats.isFile(), true);
  assert.equal(stats.isSymbolicLink(), false);
  return { path, device: stats.dev, inode: stats.ino };
}

function qualityReport(): ScoreExtractionQualityReport {
  return createScoreExtractionQualityReport({
    durationsMs: { analysis: 1, deduplication: 2, pageComposition: 3, total: 6 },
    frames: [{ frameId: "frame-000001", disposition: "accepted", scoreId: "score-0001", pageNumber: 1 }]
  });
}

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
