import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import pino from "pino";
import { defaultMediaTools, runProcess, type MediaTools } from "./media-tools";
import { ScorePipelineError, type ScoreJobInput, type ScoreJobProcessor, type ScoreJobResult } from "./score-job-service";
import { createScorePdfFromFrames, listExtractedFrames } from "./score-video-processor";

const logger = pino({ name: "yt2sheet-server" });
const MAX_DURATION_SECONDS = 2 * 60 * 60;
const MAX_EXTRACTED_FRAMES = 3_600;

type ProcessorOptions = {
  readonly dataRoot: string;
  readonly tools?: MediaTools;
};

export class YouTubeScoreProcessor implements ScoreJobProcessor {
  private readonly tools: MediaTools;

  constructor(private readonly options: ProcessorOptions) {
    this.tools = options.tools ?? defaultMediaTools;
  }

  async process(input: ScoreJobInput, onProgress: (progress: number) => void): Promise<ScoreJobResult> {
    const runId = randomUUID();
    const workDirectory = join(this.options.dataRoot, "work", runId);
    const frameDirectory = join(workDirectory, "frames");
    const resultDirectory = join(this.options.dataRoot, "results");
    const outputPath = join(resultDirectory, `${runId}.pdf`);
    await Promise.all([mkdir(frameDirectory, { recursive: true }), mkdir(resultDirectory, { recursive: true })]);

    try {
      const duration = await this.readRemoteDuration(input.videoUrl);
      onProgress(12);
      const videoPath = await this.downloadVideo(input.videoUrl, workDirectory);
      onProgress(32);
      const verifiedDuration = await this.readLocalDuration(videoPath);
      this.assertDuration(verifiedDuration || duration);
      await this.extractFrames(videoPath, frameDirectory, verifiedDuration || duration);
      onProgress(45);
      const frames = await listExtractedFrames(frameDirectory);
      if (frames.length === 0) {
        throw new ScorePipelineError("NO_FRAMES_EXTRACTED", "영상에서 분석할 프레임을 추출하지 못했습니다.");
      }
      const result = await createScorePdfFromFrames(frames, workDirectory, outputPath, onProgress);
      logger.info({ videoId: input.videoId, scoreCount: result.scoreCount, pageCount: result.pageCount }, "score job completed");
      return { filePath: outputPath, pageCount: result.pageCount };
    } catch (error) {
      await rm(outputPath, { force: true });
      if (error instanceof ScorePipelineError) {
        throw error;
      }
      logger.error({ err: error, videoId: input.videoId }, "score job failed");
      throw new ScorePipelineError("MEDIA_PROCESSING_FAILED", "YouTube 영상을 처리하지 못했습니다.", { cause: error });
    } finally {
      await rm(workDirectory, { recursive: true, force: true });
    }
  }

  private async readRemoteDuration(videoUrl: string): Promise<number> {
    const output = await runProcess(this.tools.ytDlp, ["--no-playlist", "--skip-download", "--print", "%(duration)s", videoUrl]);
    const duration = Number(output.trim().split(/\r?\n/).at(-1));
    this.assertDuration(duration);
    return duration;
  }

  private async downloadVideo(videoUrl: string, workDirectory: string): Promise<string> {
    const output = await runProcess(this.tools.ytDlp, buildVideoDownloadArguments(videoUrl, workDirectory, this.tools.ffmpeg));
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

  private async readLocalDuration(videoPath: string): Promise<number> {
    const output = await runProcess(this.tools.ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", videoPath]);
    return Number(output.trim());
  }

  private async extractFrames(videoPath: string, frameDirectory: string, duration: number): Promise<void> {
    await runProcess(this.tools.ffmpeg, buildFrameExtractionArguments(videoPath, frameDirectory, duration));
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

export function buildVideoDownloadArguments(videoUrl: string, workDirectory: string, ffmpegPath: string): string[] {
  const ffmpegLocation = isAbsolute(ffmpegPath) || ffmpegPath.includes("/") || ffmpegPath.includes("\\")
    ? ["--ffmpeg-location", ffmpegPath]
    : [];
  return [
    "--no-playlist", "--no-progress", "--max-filesize", "2G",
    "-f", "bv*[height<=1080]+ba/b[height<=1080]/best",
    ...ffmpegLocation,
    "--merge-output-format", "mp4", "-o", join(workDirectory, "source.%(ext)s"),
    "--print", "after_move:filepath", videoUrl
  ];
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
