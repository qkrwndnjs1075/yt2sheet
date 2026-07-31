import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import pino from "pino";
import { defaultMediaTools, runProcess, type MediaTools, type RunOptions } from "./media-tools";
import { deriveScoreQualitySidecarPath, serializeScoreExtractionQualityReport } from "./score-quality-report";
import { ScorePipelineError, type ScoreJobInput, type ScoreJobProcessor, type ScoreJobProcessorContext, type ScoreJobResult } from "./score-job-service";
import { createScorePdfFromFrames, listExtractedFrames } from "./score-video-processor";
import { createOwnedWorkDirectoryName } from "./workspace-cleanup";

const logger = pino({ name: "yt2sheet-server" });
const MAX_DURATION_SECONDS = 2 * 60 * 60;
const MAX_EXTRACTED_FRAMES = 3_600;

type ProcessorOptions = {
  readonly dataRoot: string;
  readonly tools?: MediaTools;
  readonly clock?: () => Date;
  readonly processRunner?: (executable: string, args: readonly string[], options?: RunOptions) => Promise<string>;
  readonly frameLister?: typeof listExtractedFrames;
  readonly pdfCreator?: typeof createScorePdfFromFrames;
  readonly sidecarWriter?: (path: string, contents: string) => Promise<void>;
  readonly sidecarRenamer?: (sourcePath: string, destinationPath: string) => Promise<void>;
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
    const workDirectory = join(this.options.dataRoot, "work", createOwnedWorkDirectoryName(runId));
    const frameDirectory = join(workDirectory, "frames");
    const resultDirectory = join(this.options.dataRoot, "results");
    const outputPath = join(resultDirectory, `yt2sheet-result-p${process.pid}-${runId}.pdf`);
    const sidecarPath = deriveScoreQualitySidecarPath(outputPath);
    const sidecarTemporaryPath = `${sidecarPath}.${randomUUID()}.tmp`;
    const { onProgress, signal } = context;
    let failed = false;
    let pdfArtifact: OwnedArtifact | null = null;
    let sidecarArtifact: OwnedArtifact | null = null;
    let sidecarTemporaryArtifact: OwnedArtifact | null = null;

    try {
      throwIfCancelled(signal);
      await Promise.all([mkdir(frameDirectory, { recursive: true }), mkdir(resultDirectory, { recursive: true })]);
      throwIfCancelled(signal);
      const duration = await this.readRemoteDuration(input.videoUrl, signal);
      throwIfCancelled(signal);
      onProgress(12);
      throwIfCancelled(signal);
      const videoPath = await this.downloadVideo(input.videoId, input.videoUrl, workDirectory, signal);
      throwIfCancelled(signal);
      onProgress(32);
      throwIfCancelled(signal);
      const verifiedDuration = await this.readLocalDuration(videoPath, signal);
      this.assertDuration(verifiedDuration || duration);
      throwIfCancelled(signal);
      await this.extractFrames(videoPath, frameDirectory, verifiedDuration || duration, signal);
      throwIfCancelled(signal);
      onProgress(45);
      throwIfCancelled(signal);
      const frames = await this.frameLister(frameDirectory);
      throwIfCancelled(signal);
      if (frames.length === 0) {
        throw new ScorePipelineError("NO_FRAMES_EXTRACTED", "영상에서 분석할 프레임을 추출하지 못했습니다.");
      }
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
        metadata: { videoId: input.videoId, createdAt: this.clock() }
      });
      pdfArtifact ??= await captureOwnedArtifact(outputPath);
      throwIfCancelled(signal);
      logger.info({ videoId: input.videoId, scoreCount: result.scoreCount, pageCount: result.pageCount }, "score job completed");
      return { filePath: outputPath, pageCount: result.pageCount };
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
    const output = await this.processRunner(this.tools.ytDlp, ["--no-playlist", "--skip-download", "--print", "%(duration)s", videoUrl], { signal });
    const duration = Number(output.trim().split(/\r?\n/).at(-1));
    this.assertDuration(duration);
    return duration;
  }

  private async downloadVideo(videoId: string, videoUrl: string, workDirectory: string, signal: AbortSignal): Promise<string> {
    let output: string;
    try {
      output = await this.processRunner(this.tools.ytDlp, buildVideoDownloadArguments(videoUrl, workDirectory, this.tools.ffmpeg), { signal });
    } catch (error) {
      if (!isYouTubeDownloadForbidden(error)) throw error;
      logger.warn({ videoId }, "retrying YouTube download with current player JavaScript");
      output = await this.processRunner(this.tools.ytDlp, buildVideoDownloadArguments(videoUrl, workDirectory, this.tools.ffmpeg, {
        useCurrentPlayerJavaScript: true,
        restartDownload: true
      }), { signal });
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

  private async readLocalDuration(videoPath: string, signal: AbortSignal): Promise<number> {
    const output = await this.processRunner(this.tools.ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", videoPath], { signal });
    return Number(output.trim());
  }

  private async extractFrames(videoPath: string, frameDirectory: string, duration: number, signal: AbortSignal): Promise<void> {
    await this.processRunner(this.tools.ffmpeg, buildFrameExtractionArguments(videoPath, frameDirectory, duration), { signal });
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

function isFileSystemError(error: unknown): boolean {
  return error instanceof Error && "code" in error;
}

export function buildFrameExtractionArguments(videoPath: string, frameDirectory: string, duration: number): string[] {
  const interval = Math.max(0.5, duration / MAX_EXTRACTED_FRAMES);
  const framesPerSecond = Number((1 / interval).toFixed(6));
  return [
    "-hide_banner", "-loglevel", "error", "-i", videoPath,
    "-vf", `fps=${framesPerSecond}`,
    "-q:v", "2",
    "-frames:v", String(MAX_EXTRACTED_FRAMES), join(frameDirectory, "frame-%06d.jpg")
  ];
}
