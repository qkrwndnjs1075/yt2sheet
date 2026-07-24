import assert from "node:assert/strict";
import { test } from "node:test";
import ky from "ky";
import { cancelScoreJob, runScoreJob, ScoreJobLifecycleError, ScoreJobNotFoundError } from "../web/src/job-client.js";

test("score job polling rejects a response for a different job identity", async () => {
  // Given
  const requests: string[] = [];
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
  const api = ky.create({
    baseUrl: "https://api.example.test/",
    fetch: async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      requests.push(`${request.method} ${new URL(request.url).pathname}`);
      const body = request.method === "POST"
        ? { jobId: "job_created", status: "queued" }
        : { jobId: "job_other", status: "succeeded", progress: 100, result: { downloadUrl: "/api/score-jobs/job_other/download", fileName: "other.pdf", pageCount: 1 } };
      return Response.json(body);
    }
  });
  const updates: string[] = [];

  // When / Then
  try {
    await assert.rejects(
      runScoreJob({
        input: { videoId: "dQw4w9WgXcQ", videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
        onUpdate: (job) => updates.push(job.jobId),
        signal: new AbortController().signal,
        pollIntervalMs: 0
      }, api),
      ScoreJobLifecycleError
    );
    assert.deepEqual(requests, ["POST /score-jobs", "GET /score-jobs/job_created"]);
    assert.deepEqual(updates, ["job_created"]);
  } finally {
    restoreProperty("window", windowDescriptor);
  }
});

function restoreProperty(key: "location" | "window", descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) {
    Object.defineProperty(globalThis, key, descriptor);
    return;
  }
  Reflect.deleteProperty(globalThis, key);
}

test("score job cancellation DELETEs the exact known job ID", async () => {
  // Given
  const requests: string[] = [];
  const api = ky.create({
    baseUrl: "https://api.example.test/",
    fetch: async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      requests.push(`${request.method} ${new URL(request.url).pathname}`);
      return Response.json({ jobId: "job_created", status: "cancelled" });
    }
  });

  // When
  const cancelled = await cancelScoreJob("job_created", api);

  // Then
  assert.deepEqual(cancelled, { jobId: "job_created", status: "cancelled" });
  assert.deepEqual(requests, ["DELETE /score-jobs/job_created"]);
});

test("score job polling turns a known job 404 into an interrupted lifecycle error", async () => {
  // Given
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
  const api = ky.create({
    baseUrl: "https://api.example.test/",
    fetch: async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      if (request.method === "POST") {
        return Response.json({ jobId: "job_created", status: "queued" });
      }
      return Response.json({ error: { code: "JOB_NOT_FOUND", message: "missing" } }, { status: 404 });
    }
  });

  // When / Then
  try {
    await assert.rejects(
      runScoreJob({
        input: { videoId: "dQw4w9WgXcQ", videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
        onUpdate: () => undefined,
        signal: new AbortController().signal,
        pollIntervalMs: 0
      }, api),
      ScoreJobNotFoundError
    );
  } finally {
    restoreProperty("window", windowDescriptor);
  }
});
