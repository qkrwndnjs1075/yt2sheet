import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { assertMediaTools, defaultMediaTools, type MediaTools } from "../pipeline/media-tools";
import {
  ScorePipelineError,
  type ScoreJobProcessor,
  type ScoreJobProcessorContext
} from "../pipeline/job-contract";
import type { ScoreReviewDecision } from "../pipeline/score-review-contract";
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
  readonly publication?: CliPublicationDependencies;
  readonly processorFactory?: (options: {
    readonly dataRoot: string;
    readonly tools: MediaTools;
  }) => ScoreJobProcessor;
};

export type CliJobResult = {
  readonly outputPath: string;
  readonly pageCount: number;
  readonly reviewOutcome?: "structured" | "raster-fallback";
  readonly warnings?: readonly ScoreReviewDecision[];
};

export type CliPublicationDependencies = {
  readonly rename?: (sourcePath: string, destinationPath: string) => Promise<void>;
};

export type PublishFinalPdfOptions = {
  readonly overwrite: boolean;
  readonly signal?: AbortSignal;
  readonly dependencies?: CliPublicationDependencies;
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

    throwIfCancelled(options.signal);
    const finalOutputPath = await publishFinalPdf(result.filePath, outputPath, {
      overwrite: options.overwriteOutput === true,
      signal: options.signal,
      dependencies: options.publication
    });
    return {
      outputPath: finalOutputPath,
      pageCount: result.pageCount,
      ...(result.reviewOutcome === undefined ? {} : { reviewOutcome: result.reviewOutcome }),
      ...(result.warnings === undefined ? {} : { warnings: result.warnings })
    };
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

export async function publishFinalPdf(
  sourcePath: string,
  outputPath: string,
  options: PublishFinalPdfOptions
): Promise<string> {
  await mkdir(dirname(outputPath), { recursive: true });
  const extension = extname(outputPath);
  const stem = basename(outputPath, extension);
  const directory = dirname(outputPath);
  for (let version = 1; ; version += 1) {
    const candidate = options.overwrite || version === 1
      ? outputPath
      : join(directory, `${stem}-${version}${extension}`);
    try {
      await publishToSibling(sourcePath, candidate, options);
      return candidate;
    } catch (error) {
      if (!options.overwrite && isExistingDestination(error)) continue;
      if (isAbortError(error)) throw error;
      throw new ScorePipelineError("PUBLICATION_FAILED", "최종 PDF를 게시하지 못했습니다.", { cause: error });
    }
  }
}

async function publishToSibling(sourcePath: string, destinationPath: string, options: PublishFinalPdfOptions): Promise<void> {
  throwIfCancelled(options.signal);
  const temporaryPath = join(dirname(destinationPath), `.${basename(destinationPath)}.${process.pid}-${randomUUID()}.tmp`);
  let destinationReserved = false;
  try {
    const bytes = await readFile(sourcePath);
    throwIfCancelled(options.signal);
    const handle = await open(temporaryPath, "wx");
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    throwIfCancelled(options.signal);
    if (!options.overwrite) {
      const reservation = await open(destinationPath, "wx");
      await reservation.close();
      destinationReserved = true;
    }
    throwIfCancelled(options.signal);
    await (options.dependencies?.rename ?? rename)(temporaryPath, destinationPath);
    destinationReserved = false;
  } finally {
    await rm(temporaryPath, { force: true });
    if (destinationReserved) await rm(destinationPath, { force: true });
  }
}

function isExistingDestination(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
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
