import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assertMediaTools, defaultMediaTools, type MediaTools } from "../server/media-tools";
import {
  type ScoreJobProcessor,
  type ScoreJobProcessorContext
} from "../server/score-job-service";
import { resolveCliMediaTools } from "./media-tools";

export type CliJobOptions = {
  readonly videoId: string;
  readonly videoUrl: string;
  readonly outputPath: string;
  readonly cookiesPath?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: number) => void;
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
  const tools = options.tools ? createMediaTools(options) : await resolveCliMediaTools(options.cookiesPath);
  await (options.toolValidator ?? assertMediaTools)(tools);

  const dataRoot = await mkdtemp(join(tmpdir(), "yt2sheet-cli-"));
  try {
    const processor = options.processorFactory?.({ dataRoot, tools })
      ?? await createDefaultProcessor(dataRoot, tools);
    const result = await processor.process(
      { videoId: options.videoId, videoUrl: options.videoUrl },
      createProcessorContext(options.signal, options.onProgress)
    );

    await mkdir(dirname(outputPath), { recursive: true });
    await copyFile(result.filePath, outputPath);
    return { outputPath, pageCount: result.pageCount };
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

async function createDefaultProcessor(dataRoot: string, tools: MediaTools): Promise<ScoreJobProcessor> {
  process.env.YT2SHEET_LOG_LEVEL ??= "silent";
  const { YouTubeScoreProcessor } = await import("../server/youtube-score-processor");
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
  onProgress: ((progress: number) => void) | undefined
): ScoreJobProcessorContext {
  const progressHandler = onProgress ?? (() => undefined);
  return Object.assign(progressHandler, {
    onProgress: progressHandler,
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
