import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { assertMediaTools, defaultMediaTools, type MediaTools } from "../pipeline/media-tools";
import {
  type ScoreJobProcessor,
  type ScoreJobProcessorContext
} from "../pipeline/job-contract";
import type { ResolvedScoreTimeRange, ScoreTimeRange } from "../pipeline/score-time-range";
import { resolveCliMediaTools } from "./media-tools";
import type { YtDlpBootstrapProgressHandler } from "./yt-dlp-bootstrap";

export type CliJobOptions = {
  readonly videoId: string;
  readonly videoUrl: string;
  readonly outputPath: string;
  readonly overwriteOutput?: true;
  readonly cookiesPath?: string;
  readonly timeRange?: ScoreTimeRange;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: number) => void;
  readonly onTimeRangeResolved?: (timeRange: ResolvedScoreTimeRange) => void;
  readonly onInstallProgress?: YtDlpBootstrapProgressHandler;
  readonly tools?: MediaTools;
  readonly toolValidator?: (tools: MediaTools) => Promise<void>;
  readonly processorFactory?: (options: {
    readonly dataRoot: string;
    readonly tools: MediaTools;
  }) => ScoreJobProcessor;
};

export type CliJobResult = {
  readonly outputPath: string;
  readonly pageCount: number;
};

export async function runCliJob(options: CliJobOptions): Promise<CliJobResult> {
  const outputPath = resolve(options.outputPath);
  const tools = options.tools
    ? createMediaTools(options)
    : await resolveCliMediaTools(options.cookiesPath, options.onInstallProgress);
  await (options.toolValidator ?? assertMediaTools)(tools);

  const dataRoot = await mkdtemp(join(tmpdir(), "yt2sheet-cli-"));
  try {
    const processor = options.processorFactory?.({ dataRoot, tools })
      ?? await createDefaultProcessor(dataRoot, tools);
    const result = await processor.process(
      {
        videoId: options.videoId,
        videoUrl: options.videoUrl,
        ...(options.timeRange === undefined ? {} : { timeRange: options.timeRange })
      },
      createProcessorContext(options.signal, options.onProgress, options.onTimeRangeResolved)
    );

    await mkdir(dirname(outputPath), { recursive: true });
    const finalOutputPath = options.overwriteOutput === true
      ? await copyReplacingOutput(result.filePath, outputPath)
      : await copyWithoutReplacingOutput(result.filePath, outputPath);
    return { outputPath: finalOutputPath, pageCount: result.pageCount };
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

async function copyReplacingOutput(sourcePath: string, outputPath: string): Promise<string> {
  await copyFile(sourcePath, outputPath);
  return outputPath;
}

async function copyWithoutReplacingOutput(sourcePath: string, outputPath: string): Promise<string> {
  const extension = extname(outputPath);
  const stem = basename(outputPath, extension);
  const directory = dirname(outputPath);
  for (let version = 1; ; version += 1) {
    const candidate = version === 1 ? outputPath : join(directory, `${stem}-${version}${extension}`);
    try {
      await copyFile(sourcePath, candidate, constants.COPYFILE_EXCL);
      return candidate;
    } catch (error) {
      if (isExistingDestination(error)) continue;
      throw error;
    }
  }
}

function isExistingDestination(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

async function createDefaultProcessor(dataRoot: string, tools: MediaTools): Promise<ScoreJobProcessor> {
  process.env.YT2SHEET_LOG_LEVEL ??= "silent";
  const { YouTubeScoreProcessor } = await import("../pipeline/youtube-score-processor");
  return new YouTubeScoreProcessor({ dataRoot, tools });
}

function createMediaTools(options: CliJobOptions): MediaTools {
  const baseTools = options.tools ?? defaultMediaTools;
  return {
    ...baseTools,
    ...(options.cookiesPath ? { ytDlpCookiesPath: resolve(options.cookiesPath) } : {})
  };
}

function createProcessorContext(
  signal: AbortSignal | undefined,
  onProgress: ((progress: number) => void) | undefined,
  onTimeRangeResolved: ((timeRange: ResolvedScoreTimeRange) => void) | undefined
): ScoreJobProcessorContext {
  const progressHandler = onProgress ?? (() => undefined);
  return Object.assign(progressHandler, {
    onProgress: progressHandler,
    onTimeRangeResolved,
    signal: signal ?? new AbortController().signal
  });
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function describeCliError(error: unknown): string {
  if (isAbortError(error)) {
    return "작업을 취소했습니다.";
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "처리 중 알 수 없는 오류가 발생했습니다.";
}
