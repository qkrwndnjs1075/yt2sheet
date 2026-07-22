import ky, { type KyInstance } from "ky";
import type { FailedScoreJob, ScoreJob, ScoreJobInput, SucceededScoreJob } from "./job-contract";
import { parseScoreJobResponse } from "./job-contract";

const DEFAULT_POLL_INTERVAL_MS = 650;

export type RunScoreJobOptions = {
  readonly input: ScoreJobInput;
  readonly onUpdate: (job: ScoreJob) => void;
  readonly signal: AbortSignal;
  readonly pollIntervalMs?: number;
};

type TerminalScoreJob = SucceededScoreJob | FailedScoreJob;

export class ScoreJobLifecycleError extends Error {
  constructor(expectedJobId: string, actualJobId: string) {
    super(`Score job identity changed from ${expectedJobId} to ${actualJobId}.`);
    this.name = "ScoreJobLifecycleError";
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
    const nextJob = await api
      .get(`score-jobs/${encodeURIComponent(job.jobId)}`, { signal: options.signal })
      .json<unknown>()
      .then(parseScoreJobResponse);
    if (nextJob.jobId !== expectedJobId) {
      throw new ScoreJobLifecycleError(expectedJobId, nextJob.jobId);
    }
    job = nextJob;
    options.onUpdate(job);
  }

  return job;
}

function isTerminal(job: ScoreJob): job is TerminalScoreJob {
  switch (job.status) {
    case "queued":
    case "running":
      return false;
    case "succeeded":
    case "failed":
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
