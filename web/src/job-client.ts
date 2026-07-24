import ky, { type KyInstance } from "ky";
import { HTTPError } from "ky";
import type { CancelledScoreJob, FailedScoreJob, ScoreJob, ScoreJobInput, SucceededScoreJob } from "./job-contract";
import { parseScoreJobResponse } from "./job-contract";

const DEFAULT_POLL_INTERVAL_MS = 650;

export type RunScoreJobOptions = {
  readonly input: ScoreJobInput;
  readonly onUpdate: (job: ScoreJob) => void;
  readonly signal: AbortSignal;
  readonly pollIntervalMs?: number;
};

export type TerminalScoreJob = SucceededScoreJob | FailedScoreJob | CancelledScoreJob;

export class ScoreJobLifecycleError extends Error {
  constructor(expectedJobId: string, actualJobId: string) {
    super(`Score job identity changed from ${expectedJobId} to ${actualJobId}.`);
    this.name = "ScoreJobLifecycleError";
  }
}

export class ScoreJobNotFoundError extends Error {
  constructor(readonly jobId: string) {
    super(`Score job ${jobId} was interrupted or expired.`);
    this.name = "ScoreJobNotFoundError";
  }
}

export class ScoreJobCancellationError extends Error {
  constructor(readonly jobId: string, readonly status: ScoreJob["status"]) {
    super(`Score job ${jobId} cannot be cancelled from ${status}.`);
    this.name = "ScoreJobCancellationError";
  }
}

const scoreJobApi: KyInstance = ky.create({
  baseUrl: "/api/",
  timeout: 15_000,
  retry: {
    limit: 1,
    methods: ["get"]
  }
});

export async function runScoreJob(options: RunScoreJobOptions, api: KyInstance = scoreJobApi): Promise<TerminalScoreJob> {
  let job = await api
    .post("score-jobs", { json: options.input, signal: options.signal })
    .json<unknown>()
    .then(parseScoreJobResponse);
  const expectedJobId = job.jobId;
  options.onUpdate(job);

  while (!isTerminal(job)) {
    await waitForPoll(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, options.signal);
    const nextJob = await getKnownScoreJob(job.jobId, options.signal, api);
    if (nextJob.jobId !== expectedJobId) {
      throw new ScoreJobLifecycleError(expectedJobId, nextJob.jobId);
    }
    job = nextJob;
    options.onUpdate(job);
  }

  return job;
}

export async function cancelScoreJob(jobId: string, api: KyInstance = scoreJobApi): Promise<CancelledScoreJob> {
  let job: ScoreJob;
  try {
    job = await api
      .delete(`score-jobs/${encodeURIComponent(jobId)}`)
      .json<unknown>()
      .then(parseScoreJobResponse);
  } catch (error) {
    if (error instanceof HTTPError && error.response.status === 404) {
      throw new ScoreJobNotFoundError(jobId);
    }
    throw error;
  }

  if (job.jobId !== jobId) {
    throw new ScoreJobLifecycleError(jobId, job.jobId);
  }
  if (job.status !== "cancelled") {
    throw new ScoreJobCancellationError(jobId, job.status);
  }
  return job;
}

async function getKnownScoreJob(jobId: string, signal: AbortSignal, api: KyInstance): Promise<ScoreJob> {
  try {
    return await api
      .get(`score-jobs/${encodeURIComponent(jobId)}`, { signal })
      .json<unknown>()
      .then(parseScoreJobResponse);
  } catch (error) {
    if (error instanceof HTTPError && error.response.status === 404) {
      throw new ScoreJobNotFoundError(jobId);
    }
    throw error;
  }
}

function isTerminal(job: ScoreJob): job is TerminalScoreJob {
  switch (job.status) {
    case "queued":
    case "running":
      return false;
    case "succeeded":
    case "failed":
    case "cancelled":
      return true;
    default:
      return assertNever(job);
  }
}

function waitForPoll(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      signal.removeEventListener("abort", rejectFromAbort);
      resolve();
    }, delayMs);
    const rejectFromAbort = (): void => {
      window.clearTimeout(timeoutId);
      reject(signal.reason instanceof Error ? signal.reason : new DOMException("The score job was cancelled.", "AbortError"));
    };
    signal.addEventListener("abort", rejectFromAbort, { once: true });
  });
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected score job state: ${String(value)}`);
}
