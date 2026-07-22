import { randomUUID } from "node:crypto";

export type ScoreJobInput = {
  readonly videoId: string;
  readonly videoUrl: string;
};

export type ScoreJobResult = {
  readonly filePath: string;
  readonly pageCount: number;
};

export type ScoreJobProcessor = {
  process(input: ScoreJobInput, onProgress: (progress: number) => void): Promise<ScoreJobResult>;
};

export class ScorePipelineError extends Error {
  constructor(readonly code: string, readonly publicMessage: string, options?: ErrorOptions) {
    super(publicMessage, options);
    this.name = "ScorePipelineError";
  }
}

export type StoredScoreJob =
  | { readonly jobId: string; readonly input: ScoreJobInput; readonly status: "queued"; readonly progress: number }
  | { readonly jobId: string; readonly input: ScoreJobInput; readonly status: "running"; readonly progress: number }
  | { readonly jobId: string; readonly input: ScoreJobInput; readonly status: "succeeded"; readonly progress: 100; readonly result: ScoreJobResult }
  | { readonly jobId: string; readonly input: ScoreJobInput; readonly status: "failed"; readonly error: { readonly code: string; readonly message: string } };

type ServiceOptions = {
  readonly createId?: () => string;
};

export class ScoreJobService {
  private readonly jobs = new Map<string, StoredScoreJob>();
  private readonly createId: () => string;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly processor: ScoreJobProcessor, options: ServiceOptions = {}) {
    this.createId = options.createId ?? randomUUID;
  }

  create(input: ScoreJobInput): StoredScoreJob {
    const job: StoredScoreJob = { jobId: this.createId(), input, status: "queued", progress: 0 };
    this.jobs.set(job.jobId, job);
    this.queue = this.queue.then(() => this.run(job.jobId, input));
    return job;
  }

  get(jobId: string): StoredScoreJob | null {
    return this.jobs.get(jobId) ?? null;
  }

  whenIdle(): Promise<void> {
    return this.queue;
  }

  private async run(jobId: string, input: ScoreJobInput): Promise<void> {
    this.jobs.set(jobId, { jobId, input, status: "running", progress: 5 });
    try {
      const result = await this.processor.process(input, (progress) => {
        const bounded = Math.max(5, Math.min(99, Math.round(progress)));
        this.jobs.set(jobId, { jobId, input, status: "running", progress: bounded });
      });
      this.jobs.set(jobId, { jobId, input, status: "succeeded", progress: 100, result });
    } catch (error) {
      const failure = toPublicFailure(error);
      this.jobs.set(jobId, { jobId, input, status: "failed", error: failure });
    }
  }
}

function toPublicFailure(error: unknown): { code: string; message: string } {
  if (error instanceof ScorePipelineError) {
    return { code: error.code, message: error.publicMessage };
  }
  return { code: "PROCESSING_FAILED", message: "악보 생성 중 오류가 발생했습니다." };
}
