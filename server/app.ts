import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { z } from "zod";
import { parseYouTubeVideoId } from "../src/shared/youtube";
import type { ScoreJobService, StoredScoreJob } from "./score-job-service";

const inputSchema = z.object({
  videoId: z.string().regex(/^[a-zA-Z0-9_-]{6,}$/),
  videoUrl: z.string().url()
});

export function createScoreJobApp(service: ScoreJobService): Hono {
  const app = new Hono();

  app.get("/api/health", (context) => context.json({ status: "ok" }));

  app.post("/api/score-jobs", async (context) => {
    const body = await context.req.json<unknown>().catch(() => null);
    const parsed = inputSchema.safeParse(body);
    if (!parsed.success || parseYouTubeVideoId(parsed.data.videoUrl) !== parsed.data.videoId) {
      return context.json({ error: { code: "INVALID_YOUTUBE_URL", message: "YouTube 링크와 영상 ID가 일치하지 않습니다." } }, 400);
    }
    const job = service.create(parsed.data);
    return context.json(toPublicJob(job, context.req.url), 202);
  });

  app.get("/api/score-jobs/:jobId", (context) => {
    const job = service.get(context.req.param("jobId"));
    return job
      ? context.json(toPublicJob(job, context.req.url))
      : context.json({ error: { code: "JOB_NOT_FOUND", message: "작업을 찾을 수 없습니다." } }, 404);
  });

  app.get("/api/score-jobs/:jobId/download", async (context) => {
    const job = service.get(context.req.param("jobId"));
    if (!job || job.status !== "succeeded") {
      return context.json({ error: { code: "RESULT_NOT_FOUND", message: "완료된 결과를 찾을 수 없습니다." } }, 404);
    }
    const bytes = await readFile(job.result.filePath).catch(() => null);
    if (!bytes) {
      return context.json({ error: { code: "RESULT_NOT_FOUND", message: "결과 파일을 찾을 수 없습니다." } }, 404);
    }
    context.header("content-type", "application/pdf");
    context.header("content-disposition", `attachment; filename="yt2sheet-${job.input.videoId}.pdf"`);
    return context.body(new Uint8Array(bytes));
  });

  return app;
}

function toPublicJob(job: StoredScoreJob, requestUrl: string): object {
  switch (job.status) {
    case "queued":
    case "running":
      return { jobId: job.jobId, status: job.status, progress: job.progress };
    case "failed":
      return { jobId: job.jobId, status: job.status, error: job.error };
    case "succeeded": {
      const origin = new URL(requestUrl).origin;
      return {
        jobId: job.jobId,
        status: job.status,
        progress: 100,
        result: {
          downloadUrl: `${origin}/api/score-jobs/${encodeURIComponent(job.jobId)}/download`,
          fileName: `yt2sheet-${job.input.videoId}.pdf`,
          pageCount: job.result.pageCount
        }
      };
    }
  }
}
