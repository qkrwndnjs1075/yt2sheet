import { z } from "zod";
import { parseYouTubeVideoId } from "../../src/shared/youtube";

const INVALID_YOUTUBE_MESSAGE = "유효한 YouTube 링크를 입력해주세요.";

export type ScoreJobInput = {
  readonly videoId: string;
  readonly videoUrl: string;
};

export type ScoreJobInputResult =
  | { readonly ok: true; readonly value: ScoreJobInput }
  | { readonly ok: false; readonly message: string };

type QueuedScoreJob = {
  readonly jobId: string;
  readonly status: "queued";
  readonly progress?: number;
};

type RunningScoreJob = {
  readonly jobId: string;
  readonly status: "running";
  readonly progress?: number;
};

export type SucceededScoreJob = {
  readonly jobId: string;
  readonly status: "succeeded";
  readonly progress: 100;
  readonly result: {
    readonly downloadUrl: string;
    readonly fileName: string;
    readonly pageCount: number;
  };
};

export type FailedScoreJob = {
  readonly jobId: string;
  readonly status: "failed";
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
};

export type CancelledScoreJob = {
  readonly jobId: string;
  readonly status: "cancelled";
};

export type ScoreJob = QueuedScoreJob | RunningScoreJob | SucceededScoreJob | FailedScoreJob | CancelledScoreJob;

const scoreJobSchema = z.discriminatedUnion("status", [
  z.object({
    jobId: z.string().min(1),
    status: z.literal("queued"),
    progress: z.number().min(0).max(100).optional()
  }),
  z.object({
    jobId: z.string().min(1),
    status: z.literal("running"),
    progress: z.number().min(0).max(100).optional()
  }),
  z.object({
    jobId: z.string().min(1),
    status: z.literal("succeeded"),
    progress: z.literal(100),
    result: z.object({
      downloadUrl: z.string(),
      fileName: z.string().min(1),
      pageCount: z.number().int().positive()
    })
  }),
  z.object({
    jobId: z.string().min(1),
    status: z.literal("cancelled")
  }),
  z.object({
    jobId: z.string().min(1),
    status: z.literal("failed"),
    error: z.object({
      code: z.string().min(1),
      message: z.string().min(1)
    })
  })
]).superRefine((job, context) => {
  if (job.status === "succeeded" && !isExactDownloadUrl(job.jobId, job.result.downloadUrl)) {
    context.addIssue({
      code: "custom",
      path: ["result", "downloadUrl"],
      message: "The download URL must target the succeeded job."
    });
  }
});

function isExactDownloadUrl(jobId: string, downloadUrl: string): boolean {
  return downloadUrl === `/api/score-jobs/${encodeURIComponent(jobId)}/download`;
}

export class ScoreJobContractError extends Error {
  readonly issues: readonly z.core.$ZodIssue[];

  constructor(message: string, issues: readonly z.core.$ZodIssue[]) {
    super(message);
    this.name = "ScoreJobContractError";
    this.issues = issues;
  }
}

export function parseScoreJobInput(rawInput: string): ScoreJobInputResult {
  const videoId = parseYouTubeVideoId(rawInput.trim());
  if (!videoId) {
    return { ok: false, message: INVALID_YOUTUBE_MESSAGE };
  }

  return {
    ok: true,
    value: {
      videoId,
      videoUrl: `https://www.youtube.com/watch?v=${videoId}`
    }
  };
}

export function parseScoreJobResponse(input: unknown): ScoreJob {
  const result = scoreJobSchema.safeParse(input);
  if (!result.success) {
    throw new ScoreJobContractError("Invalid score job response.", result.error.issues);
  }

  return result.data;
}
