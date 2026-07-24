import { Hono } from "hono";
import { z } from "zod";
import { parseYouTubeVideoId } from "../src/shared/youtube";
import type { ScoreJobService, StoredScoreJob } from "./score-job-service";

const inputSchema = z.object({
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  videoUrl: z.string().url()
}).strict();

const INVALID_INPUT = {
  error: { code: "INVALID_YOUTUBE_URL", message: "YouTube 링크와 영상 ID가 일치하지 않습니다." }
} as const;
const JOB_NOT_FOUND = {
  error: { code: "JOB_NOT_FOUND", message: "작업이 중단되었거나 만료되었습니다." }
} as const;
const JOB_NOT_CANCELLABLE = {
  error: { code: "JOB_NOT_CANCELLABLE", message: "이미 종료된 작업은 취소할 수 없습니다." }
} as const;

export function createScoreJobApp(service: ScoreJobService): Hono {
  const app = new Hono();

  app.get("/api/health", (context) => context.json({ status: "ok" }));

  app.post("/api/score-jobs", async (context) => {
    const body = await context.req.json<unknown>().catch(() => null);
    const parsed = inputSchema.safeParse(body);
    if (!parsed.success || parseYouTubeVideoId(parsed.data.videoUrl) !== parsed.data.videoId) {
      return context.json(INVALID_INPUT, 400);
    }

    const admission = service.admit(parsed.data);
    switch (admission.kind) {
      case "accepted":
        return context.json(toPublicJob(admission.job), 202);
      case "capacity-reached":
        return context.json({
          error: { code: "JOB_CAPACITY_REACHED", message: "현재 두 작업이 처리 중입니다. 잠시 후 다시 시도해주세요." }
        }, 429);
      case "id-collision":
        return context.json({
          error: { code: "JOB_ID_COLLISION", message: "작업을 만들지 못했습니다. 다시 시도해주세요." }
        }, 503);
      case "shutting-down":
        return context.json({
          error: { code: "SERVICE_SHUTTING_DOWN", message: "서버가 종료 중입니다. 잠시 후 다시 시도해주세요." }
        }, 503);
      default:
        return assertNever(admission);
    }
  });

  app.get("/api/score-jobs/:jobId", (context) => {
    const job = service.get(context.req.param("jobId"));
    return job ? context.json(toPublicJob(job)) : context.json(JOB_NOT_FOUND, 404);
  });

  app.delete("/api/score-jobs/:jobId", (context) => {
    const cancellation = service.cancel(context.req.param("jobId"));
    switch (cancellation.kind) {
      case "cancelled":
        return context.json(toPublicJob(cancellation.job));
      case "not-found":
        return context.json(JOB_NOT_FOUND, 404);
      case "not-cancellable":
        return context.json(JOB_NOT_CANCELLABLE, 409);
      default:
        return assertNever(cancellation);
    }
  });

  app.get("/api/score-jobs/:jobId/download", async (context) => {
    const opened = await service.openResult(context.req.param("jobId"));
    if (opened.kind !== "opened") {
      return context.json(JOB_NOT_FOUND, 404);
    }

    let bytes: Buffer;
    try {
      bytes = await opened.handle.readFile();
    } catch (error) {
      if (isFileSystemError(error)) {
        return context.json(JOB_NOT_FOUND, 404);
      }
      throw error;
    } finally {
      await opened.handle.close();
    }
    const job = service.get(context.req.param("jobId"));
    if (job?.status !== "succeeded") {
      return context.json(JOB_NOT_FOUND, 404);
    }
    context.header("content-type", "application/pdf");
    context.header("content-disposition", `attachment; filename="yt2sheet-${job.input.videoId}.pdf"`);
    return context.body(new Uint8Array(bytes));
  });

  return app;
}

function toPublicJob(job: StoredScoreJob): object {
  switch (job.status) {
    case "queued":
    case "running":
      return { jobId: job.jobId, status: job.status, progress: job.progress };
    case "cancelled":
      return { jobId: job.jobId, status: job.status };
    case "failed":
      return { jobId: job.jobId, status: job.status, error: job.error };
    case "succeeded":
      return {
        jobId: job.jobId,
        status: job.status,
        progress: 100,
        result: {
          downloadUrl: `/api/score-jobs/${encodeURIComponent(job.jobId)}/download`,
          fileName: `yt2sheet-${job.input.videoId}.pdf`,
          pageCount: job.result.pageCount
        }
      };
    default:
      return assertNever(job);
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected variant: ${String(value)}`);
}

function isFileSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
