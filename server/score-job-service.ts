import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

// allow: SIZE_OK - reviewed Todo 2 confines the job state machine and its result capability to this service.

export type ScoreJobInput = {
  readonly videoId: string;
  readonly videoUrl: string;
};

export type ScoreJobResult = {
  readonly filePath: string;
  readonly pageCount: number;
};

export type ScoreJobProcessorContext = ((progress: number) => void) & {
  readonly onProgress: (progress: number) => void;
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

export type StoredScoreJob =
  | { readonly jobId: string; readonly input: ScoreJobInput; readonly status: "queued"; readonly progress: number }
  | { readonly jobId: string; readonly input: ScoreJobInput; readonly status: "running"; readonly progress: number }
  | { readonly jobId: string; readonly input: ScoreJobInput; readonly status: "cancelled" }
  | { readonly jobId: string; readonly input: ScoreJobInput; readonly status: "succeeded"; readonly progress: 100; readonly result: ScoreJobResult }
  | { readonly jobId: string; readonly input: ScoreJobInput; readonly status: "failed"; readonly error: { readonly code: string; readonly message: string } };

export type AdmitScoreJobResult =
  | { readonly kind: "accepted"; readonly job: Extract<StoredScoreJob, { status: "queued" }> }
  | { readonly kind: "capacity-reached" }
  | { readonly kind: "id-collision" }
  | { readonly kind: "shutting-down" };

export type CancelScoreJobResult =
  | { readonly kind: "cancelled"; readonly job: Extract<StoredScoreJob, { status: "cancelled" }> }
  | { readonly kind: "not-found" }
  | { readonly kind: "not-cancellable"; readonly job: Extract<StoredScoreJob, { status: "succeeded" | "failed" }> };

export type OpenScoreJobResult =
  | { readonly kind: "opened"; readonly handle: FileHandle }
  | { readonly kind: "not-found" }
  | { readonly kind: "invalid" };

type ScheduledTask = { cancel(): void };
type Scheduler = { schedule(task: () => Promise<void>, delayMs: number): ScheduledTask };
type OpenFile = (path: string, flags: number) => Promise<FileHandle>;

type ServiceOptions = {
  readonly createId?: () => string;
  readonly dataRoot?: string;
  readonly now?: () => number;
  readonly scheduler?: Scheduler;
  readonly openFile?: OpenFile;
};

type ActiveExecution = {
  readonly jobId: string;
  readonly controller: AbortController;
};

type ValidatedResult = {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
};

const RESULT_TTL_MS = 60 * 60 * 1_000;
const OWNED_RESULT = /^yt2sheet-result-p[1-9][0-9]*-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pdf$/i;
const INVALID_RESULT_FAILURE = { code: "INVALID_RESULT_PATH", message: "결과 파일 경로를 확인할 수 없습니다." } as const;

export class ScoreJobService {
  private readonly jobs = new Map<string, StoredScoreJob>();
  private readonly pendingJobIds: string[] = [];
  private readonly expiryTasks = new Map<string, ScheduledTask>();
  private readonly idleWaiters: Array<() => void> = [];
  private readonly createId: () => string;
  private readonly dataRoot: string;
  private readonly now: () => number;
  private readonly scheduler: Scheduler;
  private readonly openFile: OpenFile;
  private activeExecution: ActiveExecution | null = null;
  private pumpScheduled = false;
  private accepting = true;

  constructor(private readonly processor: ScoreJobProcessor, options: ServiceOptions = {}) {
    this.createId = options.createId ?? randomUUID;
    this.dataRoot = resolve(options.dataRoot ?? ".yt2sheet-data");
    this.now = options.now ?? Date.now;
    this.scheduler = options.scheduler ?? {
      schedule: (task, delayMs) => {
        const timeout = setTimeout(() => { void task(); }, delayMs);
        timeout.unref();
        return { cancel: () => clearTimeout(timeout) };
      }
    };
    this.openFile = options.openFile ?? open;
  }

  create(input: ScoreJobInput): StoredScoreJob {
    const result = this.admit(input);
    switch (result.kind) {
      case "accepted": return result.job;
      case "capacity-reached": throw new ScoreJobAdmissionError("JOB_CAPACITY_REACHED");
      case "id-collision": throw new ScoreJobAdmissionError("JOB_ID_COLLISION");
      case "shutting-down": throw new ScoreJobAdmissionError("SERVICE_SHUTTING_DOWN");
    }
  }

  admit(input: ScoreJobInput): AdmitScoreJobResult {
    if (!this.accepting) return { kind: "shutting-down" };
    if (this.activeExecution !== null && this.pendingJobIds.length >= 1) return { kind: "capacity-reached" };
    if (this.activeExecution === null && this.pendingJobIds.length >= 2) return { kind: "capacity-reached" };
    const jobId = this.createId();
    if (this.jobs.has(jobId)) return { kind: "id-collision" };

    const job = { jobId, input, status: "queued", progress: 0 } as const;
    this.jobs.set(jobId, job);
    this.pendingJobIds.push(jobId);
    this.schedulePump();
    return { kind: "accepted", job };
  }

  get(jobId: string): StoredScoreJob | null {
    return this.jobs.get(jobId) ?? null;
  }

  cancel(jobId: string): CancelScoreJobResult {
    const current = this.jobs.get(jobId);
    if (!current) return { kind: "not-found" };
    if (current.status === "cancelled") return { kind: "cancelled", job: current };
    if (current.status === "succeeded" || current.status === "failed") {
      return { kind: "not-cancellable", job: current };
    }

    const cancelled = { jobId, input: current.input, status: "cancelled" } as const;
    this.jobs.set(jobId, cancelled);
    if (current.status === "queued") {
      const index = this.pendingJobIds.indexOf(jobId);
      if (index >= 0) this.pendingJobIds.splice(index, 1);
      this.scheduleExpiry(jobId);
      this.resolveIdleIfNeeded();
    } else if (this.activeExecution?.jobId === jobId) {
      this.activeExecution.controller.abort();
    }
    return { kind: "cancelled", job: cancelled };
  }

  async openResult(jobId: string): Promise<OpenScoreJobResult> {
    const job = this.jobs.get(jobId);
    if (job?.status !== "succeeded") return { kind: "not-found" };
    const validated = await this.validateResult(job.result.filePath);
    if (!validated) return { kind: "invalid" };

    let handle: FileHandle | null = null;
    try {
      const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
      handle = await this.openFile(validated.path, constants.O_RDONLY | noFollow);
      const [openedStats, afterStats, parent] = await Promise.all([
        handle.stat(), lstat(validated.path), realpath(dirname(validated.path))
      ]);
      const root = await this.realResultsRoot();
      if (!root || !openedStats.isFile() || afterStats.isSymbolicLink() || !afterStats.isFile()
        || openedStats.dev !== validated.device || openedStats.ino !== validated.inode
        || afterStats.dev !== validated.device || afterStats.ino !== validated.inode || parent !== root) {
        await handle.close();
        return { kind: "invalid" };
      }
      return { kind: "opened", handle };
    } catch (error) {
      if (handle) await handle.close();
      if (isFileSystemError(error)) return { kind: "invalid" };
      throw error;
    }
  }

  whenIdle(): Promise<void> {
    if (this.activeExecution === null && this.pendingJobIds.length === 0) return Promise.resolve();
    return new Promise((resolveIdle) => this.idleWaiters.push(resolveIdle));
  }

  async shutdown(): Promise<void> {
    this.accepting = false;
    for (const jobId of [...this.pendingJobIds]) this.cancel(jobId);
    if (this.activeExecution) this.cancel(this.activeExecution.jobId);
    await this.whenIdle();
    for (const task of this.expiryTasks.values()) task.cancel();
    this.expiryTasks.clear();
  }

  private schedulePump(): void {
    if (this.pumpScheduled || this.activeExecution !== null) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.startNext();
    });
  }

  private startNext(): void {
    if (this.activeExecution !== null) return;
    const jobId = this.pendingJobIds.shift();
    if (!jobId) {
      this.resolveIdleIfNeeded();
      return;
    }
    const queued = this.jobs.get(jobId);
    if (queued?.status !== "queued") {
      this.schedulePump();
      return;
    }
    const controller = new AbortController();
    this.activeExecution = { jobId, controller };
    this.jobs.set(jobId, { jobId, input: queued.input, status: "running", progress: 5 });
    void this.run(jobId, queued.input, controller.signal).finally(() => {
      if (this.activeExecution?.jobId === jobId) this.activeExecution = null;
      const current = this.jobs.get(jobId);
      if (current?.status === "cancelled") this.scheduleExpiry(jobId);
      this.schedulePump();
      this.resolveIdleIfNeeded();
    });
  }

  private async run(jobId: string, input: ScoreJobInput, signal: AbortSignal): Promise<void> {
    const onProgress = (progress: number): void => {
      const current = this.jobs.get(jobId);
      if (current?.status !== "running") return;
      const bounded = Math.max(5, Math.min(99, Math.round(progress)));
      this.jobs.set(jobId, { jobId, input, status: "running", progress: Math.max(current.progress, bounded) });
    };
    const context = Object.assign(onProgress, { onProgress, signal });
    try {
      const result = await this.processor.process(input, context);
      if (this.jobs.get(jobId)?.status !== "running") return;
      const validated = await this.validateResult(result.filePath);
      if (!validated) {
        this.jobs.set(jobId, { jobId, input, status: "failed", error: INVALID_RESULT_FAILURE });
      } else {
        this.jobs.set(jobId, { jobId, input, status: "succeeded", progress: 100, result: { ...result, filePath: validated.path } });
      }
      this.scheduleExpiry(jobId);
    } catch (error) {
      if (this.jobs.get(jobId)?.status !== "running") return;
      if (!(error instanceof Error)) throw error;
      this.jobs.set(jobId, { jobId, input, status: "failed", error: toPublicFailure(error) });
      this.scheduleExpiry(jobId);
    }
  }

  private scheduleExpiry(jobId: string): void {
    if (this.expiryTasks.has(jobId)) return;
    const expiresAt = this.now() + RESULT_TTL_MS;
    const scheduled = this.scheduler.schedule(async () => {
      this.expiryTasks.delete(jobId);
      await this.expire(jobId);
    }, Math.max(0, expiresAt - this.now()));
    this.expiryTasks.set(jobId, scheduled);
  }

  private async expire(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    this.jobs.delete(jobId);
    if (job.status !== "succeeded") return;
    const validated = await this.validateResult(job.result.filePath);
    if (!validated) return;
    try {
      const afterStats = await lstat(validated.path);
      if (!afterStats.isSymbolicLink() && afterStats.isFile()
        && afterStats.dev === validated.device && afterStats.ino === validated.inode) {
        await unlink(validated.path);
      }
    } catch (error) {
      if (!isFileSystemError(error)) throw error;
    }
  }

  private async validateResult(filePath: string): Promise<ValidatedResult | null> {
    try {
      const root = await this.realResultsRoot();
      if (!root) return null;
      const candidate = resolve(filePath);
      if (dirname(candidate) !== root || !OWNED_RESULT.test(basename(candidate))) return null;
      const [stats, parent, resolvedFile] = await Promise.all([lstat(candidate), realpath(dirname(candidate)), realpath(candidate)]);
      if (stats.isSymbolicLink() || !stats.isFile() || parent !== root || dirname(resolvedFile) !== root) return null;
      return { path: candidate, device: stats.dev, inode: stats.ino };
    } catch (error) {
      if (isFileSystemError(error)) return null;
      throw error;
    }
  }

  private async realResultsRoot(): Promise<string | null> {
    try {
      const realDataRoot = await realpath(this.dataRoot);
      const expectedRoot = resolve(realDataRoot, "results");
      const stats = await lstat(expectedRoot);
      if (stats.isSymbolicLink() || !stats.isDirectory()) return null;
      const root = await realpath(expectedRoot);
      return root === expectedRoot ? root : null;
    } catch (error) {
      if (isFileSystemError(error)) return null;
      throw error;
    }
  }

  private resolveIdleIfNeeded(): void {
    if (this.activeExecution !== null || this.pendingJobIds.length > 0) return;
    for (const resolveIdle of this.idleWaiters.splice(0)) resolveIdle();
  }
}

export class ScoreJobAdmissionError extends Error {
  constructor(readonly code: "JOB_CAPACITY_REACHED" | "JOB_ID_COLLISION" | "SERVICE_SHUTTING_DOWN") {
    super(code);
    this.name = "ScoreJobAdmissionError";
  }
}

function toPublicFailure(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof ScorePipelineError) return { code: error.code, message: error.publicMessage };
  return { code: "PROCESSING_FAILED", message: "악보 생성 중 오류가 발생했습니다." };
}

function isFileSystemError(error: unknown): boolean {
  return error instanceof Error && "code" in error;
}
