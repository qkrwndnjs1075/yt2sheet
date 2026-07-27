import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createScoreJobApp } from "../server/app";
import { ScoreJobService, ScorePipelineError, type ScoreJobInput, type ScoreJobProcessor } from "../server/score-job-service";

// allow: SIZE_OK - reviewed Todo 2 requires its named RED/GREEN cases in this focused service test file.

describe("score job API", () => {
  it("keeps running progress monotonic when processor callbacks arrive out of order", async () => {
    const observedProgress: number[] = [];
    let service: ScoreJobService;
    const processor: ScoreJobProcessor = {
      process: async (_input, onProgress) => {
        for (const progress of [40, 60, 20]) {
          onProgress(progress);
          const job = service.get("job-progress");
          if (job?.status === "running") {
            observedProgress.push(job.progress);
          }
        }
        return { filePath: "result.pdf", pageCount: 1 };
      }
    };
    service = new ScoreJobService(processor, { createId: () => "job-progress" });

    service.create({ videoId: "abcdefghijk", videoUrl: "https://youtu.be/abcdefghijk" });
    await service.whenIdle();

    assert.deepEqual(observedProgress, [40, 60, 60]);
  });

  it("rejects unsupported URL schemes and non-11-character YouTube ids", async () => {
    const service = new ScoreJobService(successfulProcessor("unused.pdf"), { createId: () => "job-invalid" });
    const app = createScoreJobApp(service);

    for (const body of [
      { videoId: "abc123XYZ_0", videoUrl: "ftp://youtube.com/watch?v=abc123XYZ_0" },
      { videoId: "abcdef", videoUrl: "https://youtube.com/watch?v=abcdef" }
    ]) {
      const response = await app.request("http://localhost/api/score-jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });

      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        error: { code: "INVALID_YOUTUBE_URL", message: "YouTube 링크와 영상 ID가 일치하지 않습니다." }
      });
    }
  });

  it("rejects a URL whose YouTube identity does not match videoId", async () => {
    const service = new ScoreJobService(successfulProcessor("unused.pdf"), { createId: () => "job-invalid" });
    const response = await createScoreJobApp(service).request("http://localhost/api/score-jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ videoId: "aaaaaaaaaaa", videoUrl: "https://youtu.be/bbbbbbbbbbb" })
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: { code: "INVALID_YOUTUBE_URL", message: "YouTube 링크와 영상 ID가 일치하지 않습니다." }
    });
  });

  it("rejects non-JSON and oversized job requests before processor admission", async () => {
    let processorStarts = 0;
    const service = new ScoreJobService({
      process: async () => {
        processorStarts += 1;
        return { filePath: "unused.pdf", pageCount: 1 };
      }
    }, { createId: () => "job-rejected" });
    const app = createScoreJobApp(service);

    const nonJson = await app.request("http://localhost/api/score-jobs", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify(jobInput("abcdefghijk"))
    });
    assert.equal(nonJson.status, 415);
    assert.deepEqual(await nonJson.json(), {
      error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "JSON 요청만 허용됩니다." }
    });

    const oversized = await app.request("http://localhost/api/score-jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...jobInput("abcdefghijk"),
        videoUrl: `https://www.youtube.com/watch?v=abcdefghijk&padding=${"a".repeat(5_000)}`
      })
    });
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), {
      error: { code: "REQUEST_TOO_LARGE", message: "요청 크기가 제한을 초과했습니다." }
    });

    await nextTurn();
    assert.equal(processorStarts, 0);
  });

  it("queues a valid job, publishes success, and serves only its result file", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "yt2sheet-api-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const dataRoot = join(directory, "data");
    const resultsRoot = join(dataRoot, "results");
    await mkdir(resultsRoot, { recursive: true });
    const resultPath = join(resultsRoot, ownedResultName());
    await writeFile(resultPath, "%PDF-test");
    const observedInputs: ScoreJobInput[] = [];
    const openedHandles: FileHandle[] = [];
    const service = new ScoreJobService({
      process: async (input, { onProgress }) => {
        observedInputs.push(input);
        onProgress(45);
        return { filePath: resultPath, pageCount: 2 };
      }
    }, {
      createId: () => "job-success",
      dataRoot,
      openFile: async (path, flags) => {
        const handle = await open(path, flags);
        openedHandles.push(handle);
        return handle;
      }
    });
    const app = createScoreJobApp(service);

    const createdResponse = await app.request("http://localhost/api/score-jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ videoId: "abcdefghijk", videoUrl: "https://www.youtube.com/watch?v=abcdefghijk" })
    });
    assert.equal(createdResponse.status, 202);
    assert.deepEqual(await createdResponse.json(), { jobId: "job-success", status: "queued", progress: 0 });

    await service.whenIdle();
    assert.deepEqual(observedInputs, [{
      videoId: "abcdefghijk",
      videoUrl: "https://www.youtube.com/watch?v=abcdefghijk"
    }]);
    const completedResponse = await app.request("http://localhost/api/score-jobs/job-success");
    assert.deepEqual(await completedResponse.json(), {
      jobId: "job-success",
      status: "succeeded",
      progress: 100,
      result: {
        downloadUrl: "/api/score-jobs/job-success/download",
        fileName: "yt2sheet-abcdefghijk.pdf",
        pageCount: 2
      }
    });

    const downloadResponse = await app.request("http://localhost/api/score-jobs/job-success/download");
    assert.equal(downloadResponse.status, 200);
    assert.equal(downloadResponse.headers.get("content-type"), "application/pdf");
    assert.deepEqual(Buffer.from(await downloadResponse.arrayBuffer()), await readFile(resultPath));
    assert.equal(openedHandles.every((handle) => handle.fd === -1), true);
    assert.deepEqual(await (await app.request("http://localhost/api/score-jobs/missing/download")).json(), {
      error: { code: "JOB_NOT_FOUND", message: "작업이 중단되었거나 만료되었습니다." }
    });
  });

  it("rejects PDF format selection and other unknown request keys", async () => {
    const service = new ScoreJobService(successfulProcessor("unused.pdf"), { createId: () => "unused" });
    const app = createScoreJobApp(service);

    for (const body of [
      { videoId: "abcdefghijk", videoUrl: "https://youtu.be/abcdefghijk", pdfPreset: "letter" },
      { videoId: "abcdefghijk", videoUrl: "https://youtu.be/abcdefghijk", extra: true }
    ]) {
      const response = await postJob(app, body);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), invalidInputBody());
    }
  });

  it("maps capacity, id collision, and shutdown admission outcomes to exact responses", async () => {
    const held = deferred<void>();
    const ids = ["job-a", "job-b", "job-c"];
    const service = new ScoreJobService({
      process: async (input) => {
        if (input.videoId === "aaaaaaaaaaa") await held.promise;
        return { filePath: "unused.pdf", pageCount: 1 };
      }
    }, { createId: () => ids.shift() ?? "job-c" });
    const app = createScoreJobApp(service);

    assert.equal((await postJob(app, jobInput("aaaaaaaaaaa"))).status, 202);
    await nextTurn();
    assert.equal((await postJob(app, jobInput("bbbbbbbbbbb"))).status, 202);
    assert.deepEqual(await (await app.request("http://localhost/api/score-jobs/job-a")).json(), {
      jobId: "job-a", status: "running", progress: 5
    });
    assert.deepEqual(await (await app.request("http://localhost/api/score-jobs/job-b")).json(), {
      jobId: "job-b", status: "queued", progress: 0
    });
    const capacity = await postJob(app, jobInput("ccccccccccc"));
    assert.equal(capacity.status, 429);
    assert.deepEqual(await capacity.json(), {
      error: { code: "JOB_CAPACITY_REACHED", message: "현재 두 작업이 처리 중입니다. 잠시 후 다시 시도해주세요." }
    });
    held.resolve();
    await service.whenIdle();

    const collisionService = new ScoreJobService(successfulProcessor("unused.pdf"), { createId: () => "same-id" });
    const collisionApp = createScoreJobApp(collisionService);
    assert.equal((await postJob(collisionApp, jobInput("aaaaaaaaaaa"))).status, 202);
    const collision = await postJob(collisionApp, jobInput("bbbbbbbbbbb"));
    assert.equal(collision.status, 503);
    assert.deepEqual(await collision.json(), {
      error: { code: "JOB_ID_COLLISION", message: "작업을 만들지 못했습니다. 다시 시도해주세요." }
    });
    await collisionService.shutdown();
    const shuttingDown = await postJob(collisionApp, jobInput("ccccccccccc"));
    assert.equal(shuttingDown.status, 503);
    assert.deepEqual(await shuttingDown.json(), {
      error: { code: "SERVICE_SHUTTING_DOWN", message: "서버가 종료 중입니다. 잠시 후 다시 시도해주세요." }
    });
  });

  it("publishes exact cancelled, failed, missing, and cancellation conflict bodies", async () => {
    const ids = ["job-cancelled", "job-failed"];
    const service = new ScoreJobService({
      process: async (input) => {
        if (input.videoId === "bbbbbbbbbbb") {
          throw new ScorePipelineError("MEDIA_FAILED", "처리에 실패했습니다.");
        }
        return { filePath: "unused.pdf", pageCount: 1 };
      }
    }, { createId: () => ids.shift() ?? "unused" });
    const app = createScoreJobApp(service);

    await postJob(app, jobInput("aaaaaaaaaaa"));
    const cancelled = await app.request("http://localhost/api/score-jobs/job-cancelled", { method: "DELETE" });
    assert.deepEqual(await cancelled.json(), { jobId: "job-cancelled", status: "cancelled" });
    assert.deepEqual(await (await app.request("http://localhost/api/score-jobs/job-cancelled", { method: "DELETE" })).json(), {
      jobId: "job-cancelled", status: "cancelled"
    });
    assert.deepEqual(await (await app.request("http://localhost/api/score-jobs/job-cancelled")).json(), {
      jobId: "job-cancelled", status: "cancelled"
    });

    await postJob(app, jobInput("bbbbbbbbbbb"));
    await service.whenIdle();
    assert.deepEqual(await (await app.request("http://localhost/api/score-jobs/job-failed")).json(), {
      jobId: "job-failed",
      status: "failed",
      error: { code: "MEDIA_FAILED", message: "처리에 실패했습니다." }
    });
    const conflict = await app.request("http://localhost/api/score-jobs/job-failed", { method: "DELETE" });
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), {
      error: { code: "JOB_NOT_CANCELLABLE", message: "이미 종료된 작업은 취소할 수 없습니다." }
    });

    for (const method of ["GET", "DELETE"] as const) {
      const missing = await app.request("http://localhost/api/score-jobs/old-job", { method });
      assert.equal(missing.status, 404);
      assert.deepEqual(await missing.json(), {
        error: { code: "JOB_NOT_FOUND", message: "작업이 중단되었거나 만료되었습니다." }
      });
    }
  });

  it("keeps succeeded downloads relative under a forged Host header", async (t) => {
    const fixture = await resultFixture(t);
    const resultPath = join(fixture.resultsRoot, ownedResultName());
    await writeFile(resultPath, "%PDF-host-safe");
    const service = new ScoreJobService(successfulProcessor(resultPath), {
      createId: () => "job/encoded", dataRoot: fixture.dataRoot
    });
    const app = createScoreJobApp(service);
    await postJob(app, jobInput("aaaaaaaaaaa"));
    await service.whenIdle();

    const response = await app.request("http://attacker.invalid/api/score-jobs/job%2Fencoded", {
      headers: { host: "attacker.invalid" }
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.downloadUrl, "/api/score-jobs/job%2Fencoded/download");
  });
});

async function postJob(app: ReturnType<typeof createScoreJobApp>, body: unknown): Promise<Response> {
  return await app.request("http://localhost/api/score-jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

function invalidInputBody(): object {
  return { error: { code: "INVALID_YOUTUBE_URL", message: "YouTube 링크와 영상 ID가 일치하지 않습니다." } };
}

function successfulProcessor(filePath: string): ScoreJobProcessor {
  return {
    process: async (_input, onProgress) => {
      onProgress(45);
      return { filePath, pageCount: 2 };
    }
  };
}

describe("score job service state machine", () => {
  it("rejects a third job while a cancelled running execution remains unsettled and one job is queued", async () => {
    const first = deferred<void>();
    const started: string[] = [];
    const ids = ["job-a", "job-b", "job-c", "job-c"];
    const service = new ScoreJobService({
      process: async (input, { onProgress }) => {
        started.push(input.videoId);
        onProgress(20);
        if (input.videoId === "aaaaaaaaaaa") await first.promise;
        return { filePath: "unused.pdf", pageCount: 1 };
      }
    }, { createId: () => ids.shift() ?? "job-c" });

    assert.equal(service.admit(jobInput("aaaaaaaaaaa")).kind, "accepted");
    await nextTurn();
    assert.equal(service.admit(jobInput("bbbbbbbbbbb")).kind, "accepted");
    assert.equal(service.cancel("job-a").kind, "cancelled");
    assert.equal(service.admit(jobInput("ccccccccccc")).kind, "capacity-reached");
    assert.deepEqual(started, ["aaaaaaaaaaa"]);

    first.resolve();
    await nextTurn();
    assert.equal(service.admit(jobInput("ccccccccccc")).kind, "accepted");
    await service.shutdown();
  });

  it("cancels a queued job idempotently without invoking its processor and frees admission", async () => {
    const first = deferred<void>();
    const started: string[] = [];
    const ids = ["job-a", "job-b", "job-c"];
    const service = new ScoreJobService({
      process: async (input) => {
        started.push(input.videoId);
        if (input.videoId === "aaaaaaaaaaa") await first.promise;
        return { filePath: "unused.pdf", pageCount: 1 };
      }
    }, { createId: () => ids.shift() ?? "job-c" });

    service.admit(jobInput("aaaaaaaaaaa"));
    await nextTurn();
    service.admit(jobInput("bbbbbbbbbbb"));
    assert.equal(service.cancel("job-b").kind, "cancelled");
    assert.equal(service.cancel("job-b").kind, "cancelled");
    assert.equal(service.admit(jobInput("ccccccccccc")).kind, "accepted");
    first.resolve();
    await service.whenIdle();
    assert.deepEqual(started, ["aaaaaaaaaaa", "ccccccccccc"]);
  });

  it("ignores late progress and success from a cancelled running processor", async () => {
    const finish = deferred<void>();
    let publishProgress = (_progress: number): void => {};
    const service = new ScoreJobService({
      process: async (_input, { onProgress }) => {
        publishProgress = onProgress;
        await finish.promise;
        return { filePath: "unused.pdf", pageCount: 9 };
      }
    }, { createId: () => "job-a" });

    service.admit(jobInput("aaaaaaaaaaa"));
    await nextTurn();
    service.cancel("job-a");
    publishProgress(90);
    finish.resolve();
    await service.whenIdle();
    assert.deepEqual(service.get("job-a"), {
      jobId: "job-a", input: jobInput("aaaaaaaaaaa"), status: "cancelled"
    });
  });

  it("fails closed when an id collides and preserves the original job", () => {
    const service = new ScoreJobService(successfulProcessor("unused.pdf"), { createId: () => "same-id" });
    const original = service.admit(jobInput("aaaaaaaaaaa"));
    const collision = service.admit(jobInput("bbbbbbbbbbb"));

    assert.equal(original.kind, "accepted");
    assert.equal(collision.kind, "id-collision");
    assert.equal(service.get("same-id")?.input.videoId, "aaaaaaaaaaa");
  });

  it("closes admission during graceful shutdown and aborts the running processor", async () => {
    const observedAbort = deferred<void>();
    const service = new ScoreJobService({
      process: async (_input, { signal }) => {
        signal.addEventListener("abort", () => observedAbort.resolve(), { once: true });
        await observedAbort.promise;
        throw new DOMException("cancelled", "AbortError");
      }
    }, { createId: () => "job-a" });
    service.admit(jobInput("aaaaaaaaaaa"));
    await nextTurn();

    const shutdown = service.shutdown();
    assert.equal(service.admit(jobInput("bbbbbbbbbbb")).kind, "shutting-down");
    await shutdown;
    assert.equal(service.get("job-a")?.status, "cancelled");
  });
});

describe("score job result ownership", () => {
  it("accepts only an owned regular result and returns an already-open handle", async (t) => {
    const fixture = await resultFixture(t);
    const resultPath = join(fixture.resultsRoot, ownedResultName());
    await writeFile(resultPath, "%PDF-owned");
    const service = new ScoreJobService(successfulProcessor(resultPath), {
      createId: () => "job-owned", dataRoot: fixture.dataRoot
    });
    service.admit(jobInput("aaaaaaaaaaa"));
    await service.whenIdle();

    const opened = await service.openResult("job-owned");
    assert.equal(opened.kind, "opened");
    if (opened.kind === "opened") {
      try {
        assert.equal((await opened.handle.readFile()).toString(), "%PDF-owned");
      } finally {
        await opened.handle.close();
      }
    }
  });

  for (const scenario of ["arbitrary-name", "outside", "missing", "directory", "symlink"] as const) {
    it(`marks ${scenario} processor results INVALID_RESULT_PATH without deleting the target`, async (t) => {
      const fixture = await resultFixture(t);
      const externalPath = join(fixture.root, "sentinel.pdf");
      let sentinelPath = externalPath;
      await writeFile(externalPath, "sentinel");
      let resultPath = join(fixture.resultsRoot, ownedResultName());
      if (scenario === "arbitrary-name") {
        resultPath = join(fixture.resultsRoot, "result.pdf");
        await writeFile(resultPath, "arbitrary");
      } else if (scenario === "outside") {
        resultPath = externalPath;
      } else if (scenario === "directory") {
        await mkdir(resultPath);
      } else if (scenario === "symlink") {
        await rm(externalPath);
        await mkdir(externalPath);
        sentinelPath = join(externalPath, "sentinel.txt");
        await writeFile(sentinelPath, "sentinel");
        await symlink(externalPath, resultPath, "junction");
      }
      let openCount = 0;
      const service = new ScoreJobService(successfulProcessor(resultPath), {
        createId: () => "job-invalid", dataRoot: fixture.dataRoot,
        openFile: async () => {
          openCount += 1;
          throw new Error("invalid processor result must not be opened");
        }
      });

      service.admit(jobInput("aaaaaaaaaaa"));
      await service.whenIdle();
      assert.deepEqual(service.get("job-invalid"), {
        jobId: "job-invalid", input: jobInput("aaaaaaaaaaa"), status: "failed",
        error: { code: "INVALID_RESULT_PATH", message: "결과 파일 경로를 확인할 수 없습니다." }
      });
      assert.equal(await readFile(sentinelPath, "utf8"), "sentinel");
      assert.equal(openCount, 0);
      if (scenario === "arbitrary-name") assert.equal(await readFile(resultPath, "utf8"), "arbitrary");
    });
  }

  it("rejects a results-root symlink without touching its external sentinel", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "yt2sheet-root-link-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dataRoot = join(root, "data");
    const externalRoot = join(root, "external");
    await mkdir(dataRoot);
    await mkdir(externalRoot);
    await symlink(externalRoot, join(dataRoot, "results"), "junction");
    const sentinel = join(externalRoot, ownedResultName());
    await writeFile(sentinel, "sentinel");
    const service = new ScoreJobService(successfulProcessor(sentinel), { createId: () => "job", dataRoot });

    service.admit(jobInput("aaaaaaaaaaa"));
    await service.whenIdle();
    assert.equal(service.get("job")?.status, "failed");
    assert.equal(await readFile(sentinel, "utf8"), "sentinel");
  });

  it("never serves a replacement inserted between validation and open", async (t) => {
    const fixture = await resultFixture(t);
    const resultPath = join(fixture.resultsRoot, ownedResultName());
    await writeFile(resultPath, "original");
    let replaceOnOpen = false;
    const openedHandles: FileHandle[] = [];
    const service = new ScoreJobService(successfulProcessor(resultPath), {
      createId: () => "job-race", dataRoot: fixture.dataRoot,
      openFile: async (path, flags) => {
        if (replaceOnOpen) {
          await rm(path);
          await writeFile(path, "replacement");
        }
        const handle = await import("node:fs/promises").then(({ open }) => open(path, flags));
        openedHandles.push(handle);
        return handle;
      }
    });
    service.admit(jobInput("aaaaaaaaaaa"));
    await service.whenIdle();
    replaceOnOpen = true;

    assert.equal((await service.openResult("job-race")).kind, "invalid");
    assert.equal(openedHandles[0]?.fd, -1);
  });

  it("expires the map entry before deleting only a validated owned file", async (t) => {
    const fixture = await resultFixture(t);
    const scheduled: Array<() => Promise<void>> = [];
    const resultPath = join(fixture.resultsRoot, ownedResultName());
    await writeFile(resultPath, "owned");
    const service = new ScoreJobService(successfulProcessor(resultPath), {
      createId: () => "job-expire", dataRoot: fixture.dataRoot,
      now: () => 1_000,
      scheduler: { schedule: (task, delayMs) => {
        assert.equal(delayMs, 60 * 60 * 1_000);
        scheduled.push(task);
        return { cancel: () => {} };
      } }
    });
    service.admit(jobInput("aaaaaaaaaaa"));
    await service.whenIdle();
    assert.equal(scheduled.length, 1);

    const expiry = scheduled[0]?.();
    assert.equal(service.get("job-expire"), null);
    await expiry;
    await assert.rejects(lstat(resultPath), { code: "ENOENT" });
  });
});

function jobInput(videoId: string) {
  return { videoId, videoUrl: `https://youtu.be/${videoId}` };
}

function ownedResultName(): string {
  return `yt2sheet-result-p${process.pid}-123e4567-e89b-42d3-a456-426614174000.pdf`;
}

async function resultFixture(t: { after(callback: () => void | Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "yt2sheet-results-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, "data");
  const resultsRoot = join(dataRoot, "results");
  await mkdir(resultsRoot, { recursive: true });
  return { root, dataRoot, resultsRoot };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve = (_value: T): void => {};
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
