import type { ResolvedScoreTimeRange, ScoreTimeRange } from "./score-time-range";
import type { ScoreReviewDecision } from "./score-review-contract";

export type ScoreJobInput = {
  readonly videoId: string;
  readonly videoUrl: string;
  readonly timeRange?: ScoreTimeRange;
};

export type ScoreJobResult = {
  readonly filePath: string;
  readonly pageCount: number;
  readonly reviewOutcome?: ScoreJobReviewOutcome;
  readonly warnings?: readonly ScoreReviewDecision[];
};

export type ScoreJobReviewOutcome = "structured" | "raster-fallback";

export type ScoreJobProcessorContext = ((progress: number) => void) & {
  readonly onProgress: (progress: number) => void;
  readonly onTimeRangeResolved?: (timeRange: ResolvedScoreTimeRange) => void;
  readonly signal: AbortSignal;
};

export type ScoreJobProcessor = {
  process(input: ScoreJobInput, context: ScoreJobProcessorContext): Promise<ScoreJobResult>;
};

export class ScorePipelineError extends Error {
  constructor(readonly code: string, readonly publicMessage: string, options?: ErrorOptions) {
    super(publicMessage, options);
    this.name = "ScorePipelineError";
  }
}
