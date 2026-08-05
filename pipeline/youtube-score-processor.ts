import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import pino from "pino";
import { z } from "zod";
import { transcribeAudiverisPages } from "./audiveris-adapter";
import { defaultMediaTools, runProcess, type MediaTools, type RunOptions } from "./media-tools";
import { renderMuseScoreDocument } from "./musescore-adapter";
import { reviewRasterPageFiles } from "./score-raster-review";
import { deriveScoreQualitySidecarPath, serializeScoreExtractionQualityReport } from "./score-quality-report";
import { loadScoreRuntimeManifest, resolveScoreRuntimeTarget, type ScoreRuntimeManifest, type ScoreRuntimePlatform } from "./score-runtime-manifest";
import { ScorePipelineError, type ScoreJobInput, type ScoreJobProcessor, type ScoreJobProcessorContext, type ScoreJobResult } from "./job-contract";
import { resolveScoreTimeRange, type ResolvedScoreTimeRange, type ScoreTimeRange } from "./score-time-range";
import { createScorePdfFromFrames, listExtractedFrames, type CreateScorePdfOptions } from "./score-video-processor";

const logger = pino({ name: "yt2sheet-cli", level: process.env.YT2SHEET_LOG_LEVEL?.trim() || "info" });
const MAX_DURATION_SECONDS = 2 * 60 * 60;
const MAX_EXTRACTED_FRAMES = 3_600;

export type ReviewedPipeline = NonNullable<CreateScorePdfOptions["reviewedPipeline"]>;

export type ReviewedPipelineFactory = (request: {
  readonly runtimeRoot: string;
  readonly assetRoot: string;
}) => Promise<ReviewedPipeline>;

type ProcessorOptions = {
  readonly dataRoot: string;
  readonly tools?: MediaTools;
  readonly clock?: () => Date;
  readonly processRunner?: (executable: string, args: readonly string[], options?: RunOptions) => Promise<string>;
  readonly frameLister?: typeof listExtractedFrames;
  readonly pdfCreator?: typeof createScorePdfFromFrames;
  readonly sidecarWriter?: (path: string, contents: string) => Promise<void>;
  readonly sidecarRenamer?: (sourcePath: string, destinationPath: string) => Promise<void>;
  readonly reviewedPipelineFactory?: ReviewedPipelineFactory;
};

type OwnedArtifact = {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
};

export class YouTubeScoreProcessor implements ScoreJobProcessor {
  private readonly tools: MediaTools;
  private readonly clock: () => Date;
  private readonly processRunner: (executable: string, args: readonly string[], options?: RunOptions) => Promise<string>;
  private readonly frameLister: typeof listExtractedFrames;
  private readonly pdfCreator: typeof createScorePdfFromFrames;
  private readonly sidecarWriter: (path: string, contents: string) => Promise<void>;
  private readonly sidecarRenamer: (sourcePath: string, destinationPath: string) => Promise<void>;

  constructor(private readonly options: ProcessorOptions) {
    this.tools = options.tools ?? defaultMediaTools;
    this.clock = options.clock ?? (() => new Date());
    this.processRunner = options.processRunner ?? runProcess;
    this.frameLister = options.frameLister ?? listExtractedFrames;
    this.pdfCreator = options.pdfCreator ?? createScorePdfFromFrames;
    this.sidecarWriter = options.sidecarWriter ?? ((path, contents) => writeFile(path, contents, { encoding: "utf8", flag: "wx" }));
    this.sidecarRenamer = options.sidecarRenamer ?? rename;
  }

  async process(input: ScoreJobInput, context: ScoreJobProcessorContext): Promise<ScoreJobResult> {
    const runId = randomUUID();
    const workDirectory = join(this.options.dataRoot, "work", `worker-${process.pid}-${runId}`);
    const frameDirectory = join(workDirectory, "frames");
    const resultDirectory = join(this.options.dataRoot, "results");
    const outputPath = join(resultDirectory, `yt2sheet-result-p${process.pid}-${runId}.pdf`);
    const sidecarPath = deriveScoreQualitySidecarPath(outputPath);
    const sidecarTemporaryPath = `${sidecarPath}.${randomUUID()}.tmp`;
    const { onProgress, onTimeRangeResolved, signal } = context;
    let failed = false;
    let pdfArtifact: OwnedArtifact | null = null;
    let sidecarArtifact: OwnedArtifact | null = null;
    let sidecarTemporaryArtifact: OwnedArtifact | null = null;

    try {
      throwIfCancelled(signal);
      await Promise.all([mkdir(frameDirectory, { recursive: true }), mkdir(resultDirectory, { recursive: true })]);
      throwIfCancelled(signal);
      const remoteDuration = await this.readRemoteDuration(input.videoUrl, signal);
      const remoteTimeRange = this.resolveTimeRange(input.timeRange, remoteDuration);
      throwIfCancelled(signal);
      onTimeRangeResolved?.(remoteTimeRange);
      onProgress(12);
      throwIfCancelled(signal);
      const videoPath = await this.downloadVideo(input.videoId, input.videoUrl, workDirectory, signal);
      throwIfCancelled(signal);
      onProgress(32);
      throwIfCancelled(signal);
      const localDuration = await this.readLocalDuration(videoPath, signal);
      this.assertDuration(localDuration);
      const timeRange = this.resolveTimeRange(input.timeRange, localDuration);
      throwIfCancelled(signal);
      await this.extractFrames(videoPath, frameDirectory, timeRange, signal);
      throwIfCancelled(signal);
      onProgress(45);
      throwIfCancelled(signal);
      const frames = await this.frameLister(frameDirectory);
      throwIfCancelled(signal);
      if (frames.length === 0) {
        throw new ScorePipelineError("NO_FRAMES_EXTRACTED", "영상에서 분석할 프레임을 추출하지 못했습니다.");
      }
      const reviewedPipeline = await (this.options.reviewedPipelineFactory ?? createInstalledReviewedPipeline)({
        runtimeRoot: defaultRuntimeRoot(),
        assetRoot: defaultAssetRoot()
      });
      const result = await this.pdfCreator(frames, workDirectory, outputPath, {
        onProgress,
        signal,
        outputArtifactSink: async () => {
          pdfArtifact = await captureOwnedArtifact(outputPath);
        },
        qualityReportSink: async (report) => {
          throwIfCancelled(signal);
          pdfArtifact ??= await captureOwnedArtifact(outputPath);
          await this.sidecarWriter(sidecarTemporaryPath, serializeScoreExtractionQualityReport(report));
          sidecarTemporaryArtifact = await captureOwnedArtifact(sidecarTemporaryPath);
          throwIfCancelled(signal);
          await this.sidecarRenamer(sidecarTemporaryPath, sidecarPath);
          sidecarArtifact = await captureOwnedArtifact(sidecarPath);
          throwIfCancelled(signal);
        },
        reviewedPipeline,
        metadata: { videoId: input.videoId, createdAt: this.clock() }
      });
      pdfArtifact ??= await captureOwnedArtifact(outputPath);
      throwIfCancelled(signal);
      logger.info({ videoId: input.videoId, scoreCount: result.scoreCount, pageCount: result.pageCount }, "score job completed");
      return {
        filePath: outputPath,
        pageCount: result.pageCount,
        ...(result.reviewOutcome === undefined ? {} : { reviewOutcome: result.reviewOutcome }),
        ...(result.warnings === undefined ? {} : { warnings: result.warnings })
      };
    } catch (error) {
      failed = true;
      await Promise.allSettled([
        unlinkMatchingArtifact(pdfArtifact),
        unlinkMatchingArtifact(sidecarArtifact),
        unlinkMatchingArtifact(sidecarTemporaryArtifact)
      ]);
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      if (error instanceof ScorePipelineError) {
        throw error;
      }
      logger.error({ err: error, videoId: input.videoId }, "score job failed");
      throw new ScorePipelineError("MEDIA_PROCESSING_FAILED", "YouTube 영상을 처리하지 못했습니다.", { cause: error });
    } finally {
      const cleanup = rm(workDirectory, { recursive: true, force: true });
      if (failed) {
        await Promise.allSettled([cleanup]);
      } else {
        await cleanup;
      }
    }
  }

  private async readRemoteDuration(videoUrl: string, signal: AbortSignal): Promise<number> {
    const output = await this.runYtDlp([
      ...buildYtDlpRuntimeArguments(this.tools),
      "--no-playlist", "--skip-download", "--print", "%(duration)s", videoUrl
    ], signal);
    const duration = Number(output.trim().split(/\r?\n/).at(-1));
    this.assertDuration(duration);
    return duration;
  }

  private async downloadVideo(videoId: string, videoUrl: string, workDirectory: string, signal: AbortSignal): Promise<string> {
    const downloaderOptions: VideoDownloadOptions = {
      ytDlpJsRuntime: this.tools.ytDlpJsRuntime,
      ytDlpCookiesPath: this.tools.ytDlpCookiesPath
    };
    let output: string;
    try {
      output = await this.runYtDlp(
        buildVideoDownloadArguments(videoUrl, workDirectory, this.tools.ffmpeg, downloaderOptions),
        signal
      );
    } catch (error) {
      if (!isYouTubeDownloadForbidden(error)) throw error;
      logger.warn({ videoId }, "retrying YouTube download with current player JavaScript");
      output = await this.runYtDlp(
        buildVideoDownloadArguments(videoUrl, workDirectory, this.tools.ffmpeg, {
          ...downloaderOptions,
          useCurrentPlayerJavaScript: true,
          restartDownload: true
        }),
        signal
      );
    }
    const reportedPath = output.trim().split(/\r?\n/).filter(Boolean).at(-1);
    if (!reportedPath) {
      throw new ScorePipelineError("DOWNLOAD_FAILED", "YouTube 영상을 다운로드하지 못했습니다.");
    }
    const absolutePath = isAbsolute(reportedPath) ? resolve(reportedPath) : resolve(workDirectory, reportedPath);
    const root = resolve(workDirectory) + sep;
    if (!absolutePath.startsWith(root)) {
      throw new ScorePipelineError("DOWNLOAD_FAILED", "다운로드된 영상 경로를 확인할 수 없습니다.");
    }
    return absolutePath;
  }

  private async runYtDlp(args: readonly string[], signal: AbortSignal): Promise<string> {
    try {
      return await this.processRunner(this.tools.ytDlp, args, { signal });
    } catch (error) {
      throw toYouTubeAccessBlockedError(error) ?? error;
    }
  }

  private async readLocalDuration(videoPath: string, signal: AbortSignal): Promise<number> {
    const output = await this.processRunner(this.tools.ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", videoPath], { signal });
    return Number(output.trim());
  }

  private async extractFrames(videoPath: string, frameDirectory: string, timeRange: ResolvedScoreTimeRange, signal: AbortSignal): Promise<void> {
    await this.processRunner(this.tools.ffmpeg, buildFrameExtractionArguments(videoPath, frameDirectory, timeRange), { signal });
  }

  private resolveTimeRange(timeRange: ScoreTimeRange | undefined, duration: number): ResolvedScoreTimeRange {
    const resolution = resolveScoreTimeRange(timeRange, duration);
    if (resolution.kind === "invalid") {
      throw new ScorePipelineError("INVALID_TIME_RANGE", "요청한 시간 범위를 영상 길이에 맞게 확인해 주세요.");
    }
    return resolution;
  }

  private assertDuration(duration: number): void {
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new ScorePipelineError("INVALID_VIDEO", "영상 길이를 확인할 수 없습니다.");
    }
    if (duration > MAX_DURATION_SECONDS) {
      throw new ScorePipelineError("VIDEO_TOO_LONG", "현재는 2시간 이하 영상만 처리할 수 있습니다.");
    }
  }
}

export type LocalVideoJobInput = Readonly<{
  readonly videoPath: string;
  readonly videoId: string;
  readonly durationMs?: number;
  readonly timeRange?: ScoreTimeRange;
}>;

export type LocalVideoProcessorOptions = Readonly<{
  readonly dataRoot: string;
  readonly tools?: Pick<MediaTools, "ffmpeg" | "ffprobe">;
  readonly clock?: () => Date;
  readonly processRunner?: (executable: string, args: readonly string[], options?: RunOptions) => Promise<string>;
  readonly frameLister?: typeof listExtractedFrames;
  readonly pdfCreator?: typeof createScorePdfFromFrames;
  readonly reviewedPipelineFactory?: () => Promise<ReviewedPipeline | undefined>;
  readonly frameArtifactSink?: (framePaths: readonly string[]) => Promise<void>;
}>;

export class LocalVideoScoreProcessor {
  private readonly tools: Pick<MediaTools, "ffmpeg" | "ffprobe">;
  private readonly clock: () => Date;
  private readonly processRunner: (executable: string, args: readonly string[], options?: RunOptions) => Promise<string>;
  private readonly frameLister: typeof listExtractedFrames;
  private readonly pdfCreator: typeof createScorePdfFromFrames;

  constructor(private readonly options: LocalVideoProcessorOptions) {
    this.tools = options.tools ?? { ffmpeg: defaultMediaTools.ffmpeg, ffprobe: defaultMediaTools.ffprobe };
    this.clock = options.clock ?? (() => new Date());
    this.processRunner = options.processRunner ?? runProcess;
    this.frameLister = options.frameLister ?? listExtractedFrames;
    this.pdfCreator = options.pdfCreator ?? createScorePdfFromFrames;
  }

  async process(input: LocalVideoJobInput, context: ScoreJobProcessorContext): Promise<ScoreJobResult> {
    const videoPath = resolve(input.videoPath);
    if (!isAbsolute(input.videoPath) || input.videoPath.includes("://")) {
      throw new ScorePipelineError("INVALID_LOCAL_VIDEO", "로컬 영상 경로를 확인할 수 없습니다.");
    }
    const runId = randomUUID();
    const workDirectory = join(this.options.dataRoot, "work", `local-worker-${process.pid}-${runId}`);
    const frameDirectory = join(workDirectory, "frames");
    const resultDirectory = join(this.options.dataRoot, "results");
    const outputPath = join(resultDirectory, `benchmark-result-p${process.pid}-${runId}.pdf`);
    let failed = false;
    try {
      throwIfCancelled(context.signal);
      const sourceStats = await lstat(videoPath).catch(() => null);
      if (sourceStats === null || sourceStats.isSymbolicLink() || !sourceStats.isFile()) {
        throw new ScorePipelineError("INVALID_LOCAL_VIDEO", "로컬 영상 경로를 확인할 수 없습니다.");
      }
      await mkdir(frameDirectory, { recursive: true });
      await mkdir(resultDirectory, { recursive: true });
      const probedDuration = Number((await this.processRunner(this.tools.ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", videoPath], { signal: context.signal })).trim());
      const duration = Number.isFinite(probedDuration) && probedDuration > 0 ? probedDuration : (input.durationMs === undefined ? NaN : input.durationMs / 1_000);
      if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_DURATION_SECONDS) {
        throw new ScorePipelineError("INVALID_LOCAL_VIDEO", "로컬 영상 길이를 확인할 수 없습니다.");
      }
      const range = resolveScoreTimeRange(input.timeRange, duration);
      if (range.kind === "invalid") throw new ScorePipelineError("INVALID_TIME_RANGE", "요청한 시간 범위를 확인해 주세요.");
      context.onTimeRangeResolved?.(range);
      context.onProgress(12);
      const extractionArguments = buildFrameExtractionArguments(videoPath, frameDirectory, range);
      if (/\.(?:svg|png|jpe?g)$/iu.test(videoPath)) {
        extractionArguments.unshift("-loop", "1");
        const filterIndex = extractionArguments.indexOf("-vf");
        extractionArguments.splice(filterIndex < 0 ? extractionArguments.length : filterIndex, 0, "-t", String(range.sampleDurationSec));
      }
      extractionArguments.splice(extractionArguments.length - 1, 0, "-pix_fmt", "yuvj420p");
      await this.processRunner(this.tools.ffmpeg, extractionArguments, { signal: context.signal });
      throwIfCancelled(context.signal);
      context.onProgress(45);
      const frames = await this.frameLister(frameDirectory);
      if (frames.length === 0) throw new ScorePipelineError("NO_FRAMES_EXTRACTED", "영상에서 분석할 프레임을 추출하지 못했습니다.");
      await this.options.frameArtifactSink?.(frames);
      const reviewedPipeline = await this.options.reviewedPipelineFactory?.();
      const result = await this.pdfCreator(frames, workDirectory, outputPath, {
        onProgress: context.onProgress,
        signal: context.signal,
        reviewedPipeline: reviewedPipeline === undefined ? undefined : { stages: reviewedPipeline.stages },
        metadata: { videoId: input.videoId, createdAt: this.clock() }
      });
      throwIfCancelled(context.signal);
      return {
        filePath: outputPath,
        pageCount: result.pageCount,
        reviewOutcome: result.reviewOutcome ?? "raster-fallback",
        ...(result.warnings === undefined ? {} : { warnings: result.warnings })
      };
    } catch (error) {
      failed = true;
      if (error instanceof Error && error.name === "AbortError") throw error;
      if (error instanceof ScorePipelineError) throw error;
      throw new ScorePipelineError("MEDIA_PROCESSING_FAILED", "로컬 영상을 처리하지 못했습니다.", { cause: error });
    } finally {
      const cleanup = rm(workDirectory, { recursive: true, force: true });
      if (failed) await Promise.allSettled([cleanup]);
      else await cleanup;
    }
  }
}

async function captureOwnedArtifact(path: string): Promise<OwnedArtifact | null> {
  try {
    const stats = await lstat(path, { bigint: true });
    if (stats.isSymbolicLink() || !stats.isFile()) return null;
    return { path, device: stats.dev, inode: stats.ino };
  } catch (error) {
    if (isFileSystemError(error)) return null;
    throw error;
  }
}

async function unlinkMatchingArtifact(artifact: OwnedArtifact | null): Promise<void> {
  if (!artifact) return;
  const stats = await lstat(artifact.path, { bigint: true });
  if (!stats.isSymbolicLink() && stats.isFile()
    && stats.dev === artifact.device && stats.ino === artifact.inode) {
    await unlink(artifact.path);
  }
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
}

type VideoDownloadOptions = {
  readonly useCurrentPlayerJavaScript?: boolean;
  readonly restartDownload?: boolean;
  readonly ytDlpJsRuntime?: string;
  readonly ytDlpCookiesPath?: string;
};

export function buildVideoDownloadArguments(
  videoUrl: string,
  workDirectory: string,
  ffmpegPath: string,
  options: VideoDownloadOptions = {}
): string[] {
  const ffmpegLocation = isAbsolute(ffmpegPath) || ffmpegPath.includes("/") || ffmpegPath.includes("\\")
    ? ["--ffmpeg-location", ffmpegPath]
    : [];
  return [
    ...buildYtDlpRuntimeArguments(options),
    "--no-playlist", "--no-progress", "--max-filesize", "2G",
    "-f", "bv*[height<=1080]+ba/b[height<=1080]/best",
    ...(options.useCurrentPlayerJavaScript ? ["--extractor-args", "youtube:player_js_version=actual"] : []),
    ...(options.restartDownload ? ["--no-continue"] : []),
    ...ffmpegLocation,
    "--merge-output-format", "mp4", "-o", join(workDirectory, "source.%(ext)s"),
    "--print", "after_move:filepath", videoUrl
  ];
}

function isYouTubeDownloadForbidden(error: unknown): boolean {
  return error instanceof Error && /HTTP Error 403: Forbidden/i.test(error.message);
}

function buildYtDlpRuntimeArguments(options: Pick<VideoDownloadOptions, "ytDlpJsRuntime" | "ytDlpCookiesPath">): string[] {
  const jsRuntime = options.ytDlpJsRuntime?.trim() || "node";
  const cookiesPath = options.ytDlpCookiesPath?.trim();
  return [
    "--js-runtimes", jsRuntime,
    ...(cookiesPath ? ["--cookies", cookiesPath] : [])
  ];
}

function toYouTubeAccessBlockedError(error: unknown): ScorePipelineError | null {
  if (!(error instanceof Error) || !/HTTP Error 429: Too Many Requests|Sign in to confirm[\s\S]*not a bot/i.test(error.message)) {
    return null;
  }
  return new ScorePipelineError(
    "YOUTUBE_ACCESS_BLOCKED",
    "YouTube가 서버 요청을 봇으로 차단했습니다. 인증 쿠키를 설정하거나 잠시 후 다시 시도해 주세요.",
    { cause: error }
  );
}

function isFileSystemError(error: unknown): boolean {
  return error instanceof Error && "code" in error;
}

async function createInstalledReviewedPipeline(request: { readonly runtimeRoot: string; readonly assetRoot: string }): Promise<ReviewedPipeline> {
  const manifest = await loadInstalledScoreRuntimeManifest(request.assetRoot);
  const target = await resolveDefaultRuntimeTarget(manifest);
  const leland = manifest.tools.musescore.fonts.find((font) => font.family === "Leland");
  const expectedLelandFontSha256 = leland === undefined ? "" : await digestDirectory(resolve(request.runtimeRoot, leland.bundledPath));
  return {
    stages: {
      reviewRaster: async ({ pages, signal }) => reviewRasterPageFiles(pages, signal),
      transcribe: ({ pages, signal }) => transcribeAudiverisPages({
        manifest,
        platformId: target.id,
        runtimeRoot: request.runtimeRoot,
        workspaceRoot: dirname(pages[0]?.path ?? request.runtimeRoot),
        pages,
        rasterSafe: true,
        signal
      }),
      render: ({ pages, outputPath, signal }) => renderMuseScoreDocument({
        manifest,
        releaseTarget: target.releaseTarget,
        osVersion: target.osVersion,
        bundleRoot: request.runtimeRoot,
        assetRoot: request.assetRoot,
        expectedLelandFontSha256,
        outputPath,
        pages,
        signal
      })
    }
  };
}

async function loadInstalledScoreRuntimeManifest(assetRoot: string): Promise<ScoreRuntimeManifest> {
  const candidates = [
    resolve(assetRoot, "scripts/score-runtime-manifest.json"),
    resolve(assetRoot, "app/scripts/score-runtime-manifest.json"),
    resolve(process.cwd(), "scripts/score-runtime-manifest.json")
  ];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return await loadScoreRuntimeManifest(candidate);
    } catch (error) {
      if (!isFileSystemError(error)) throw error;
      lastError = error;
    }
  }
  throw lastError ?? new Error("score runtime manifest is unavailable");
}

export async function resolveDefaultRuntimeTarget(
  manifest: ScoreRuntimeManifest,
  options: Readonly<{ platform?: string; architecture?: string; osReleasePath?: string }> = {}
): Promise<ScoreRuntimePlatform> {
  const hostPlatform = options.platform ?? process.platform;
  const hostArchitecture = options.architecture ?? process.arch;
  if (hostPlatform === "darwin" && hostArchitecture === "arm64") return resolveScoreRuntimeTarget(manifest, "darwin-arm64", "14");
  if (hostPlatform === "darwin" && hostArchitecture === "x64") return resolveScoreRuntimeTarget(manifest, "darwin-x64", "14");
  if (hostPlatform === "win32" && hostArchitecture === "x64") return resolveScoreRuntimeTarget(manifest, "windows-x64", "2022");
  if (hostPlatform !== "linux" || hostArchitecture !== "x64") {
    throw new Error(`지원하지 않는 점수 런타임 호스트입니다: ${hostPlatform}-${hostArchitecture}`);
  }
  const source = await readFile(options.osReleasePath ?? process.env.YT2SHEET_OS_RELEASE_FILE?.trim() ?? "/etc/os-release", "utf8");
  const fields = Object.fromEntries(source.split(/\r?\n/u).flatMap((line) => {
    const match = /^([A-Z_]+)=(?:"([^"]*)"|'([^']*)'|([^#\s]*))$/u.exec(line);
    return match?.[1] ? [[match[1], match[2] ?? match[3] ?? match[4] ?? ""]] : [];
  }));
  if (fields.ID !== "ubuntu" || (fields.VERSION_ID !== "22.04" && fields.VERSION_ID !== "24.04")) {
    throw new Error(`지원하는 점수 런타임은 Ubuntu 22.04/24.04 x64입니다: ${fields.ID ?? "unknown"} ${fields.VERSION_ID ?? "unknown"}`);
  }
  return resolveScoreRuntimeTarget(manifest, "linux-x64", fields.VERSION_ID);
}

async function digestDirectory(root: string): Promise<string> {
  try {
    const files = await directoryFiles(root);
    const hash = createHash("sha256");
    for (const file of files) hash.update(relative(root, file).split(sep).join("/")).update("\0").update(await readFile(file));
    return files.length === 0 ? "" : hash.digest("hex");
  } catch (error) {
    if (isFileSystemError(error)) return "";
    throw error;
  }
}

async function directoryFiles(root: string): Promise<readonly string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(root, entry.name);
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) throw new TypeError("runtime-font-symlink");
    if (stats.isDirectory()) files.push(...await directoryFiles(path));
    else if (stats.isFile()) files.push(path);
  }
  return files.sort();
}

function defaultRuntimeRoot(): string {
  const configured = process.env.YT2SHEET_RUNTIME_ROOT?.trim();
  if (configured) return resolve(configured);
  const executable = process.argv[1];
  const candidates = [
    process.cwd(),
    ...(executable === undefined ? [] : [resolve(dirname(executable), "..", "..", ".."), resolve(dirname(executable), "..", "..")])
  ];
  return candidates.find((candidate) => existsSync(join(candidate, "tools"))) ?? resolve(process.cwd());
}

function defaultAssetRoot(): string {
  const configured = process.env.YT2SHEET_ASSET_ROOT?.trim();
  return configured ? resolve(configured) : defaultRuntimeRoot();
}

export function buildFrameExtractionArguments(
  videoPath: string,
  frameDirectory: string,
  durationOrRange: number | ResolvedScoreTimeRange
): string[] {
  const timeRange = typeof durationOrRange === "number" ? undefined : durationOrRange;
  const duration = typeof durationOrRange === "number" ? durationOrRange : durationOrRange.sampleDurationSec;
  const interval = Math.max(0.5, duration / MAX_EXTRACTED_FRAMES);
  const framesPerSecond = Number((1 / interval).toFixed(6));
  return [
    "-hide_banner", "-loglevel", "error", "-i", videoPath,
    ...(timeRange?.kind === "explicit" && timeRange.hasStartBound ? ["-ss", String(timeRange.startTimeSec)] : []),
    ...(timeRange?.kind === "explicit" && timeRange.hasEndBound ? ["-t", String(timeRange.sampleDurationSec)] : []),
    "-vf", `fps=${framesPerSecond}`,
    "-q:v", "2",
    "-frames:v", String(MAX_EXTRACTED_FRAMES), join(frameDirectory, "frame-%06d.jpg")
  ];
}
