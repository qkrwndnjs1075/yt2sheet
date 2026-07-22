import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createScoreJobApp } from "../server/app";
import { ScoreJobService, type ScoreJobProcessor } from "../server/score-job-service";

describe("score job API", () => {
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

  it("queues a valid job, publishes success, and serves only its result file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yt2sheet-api-"));
    const resultPath = join(directory, "result.pdf");
    await writeFile(resultPath, "%PDF-test");
    const service = new ScoreJobService(successfulProcessor(resultPath), { createId: () => "job-success" });
    const app = createScoreJobApp(service);

    const createdResponse = await app.request("http://localhost/api/score-jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ videoId: "abcdefghijk", videoUrl: "https://www.youtube.com/watch?v=abcdefghijk" })
    });
    assert.equal(createdResponse.status, 202);
    assert.deepEqual(await createdResponse.json(), { jobId: "job-success", status: "queued", progress: 0 });

    await service.whenIdle();
    const completedResponse = await app.request("http://localhost/api/score-jobs/job-success");
    assert.deepEqual(await completedResponse.json(), {
      jobId: "job-success",
      status: "succeeded",
      progress: 100,
      result: {
        downloadUrl: "http://localhost/api/score-jobs/job-success/download",
        fileName: "yt2sheet-abcdefghijk.pdf",
        pageCount: 2
      }
    });

    const downloadResponse = await app.request("http://localhost/api/score-jobs/job-success/download");
    assert.equal(downloadResponse.status, 200);
    assert.equal(downloadResponse.headers.get("content-type"), "application/pdf");
    assert.deepEqual(Buffer.from(await downloadResponse.arrayBuffer()), await readFile(resultPath));
    assert.equal((await app.request("http://localhost/api/score-jobs/missing/download")).status, 404);
  });
});

function successfulProcessor(filePath: string): ScoreJobProcessor {
  return {
    process: async (_input, onProgress) => {
      onProgress(45);
      return { filePath, pageCount: 2 };
    }
  };
}
