import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { join } from "node:path";
import { runCliJob } from "../cli/job";
import { ScorePipelineError } from "../pipeline/job-contract";

const tools = { ytDlp: process.execPath, ffmpeg: process.execPath, ffprobe: process.execPath } as const;

test("does not publish after cancellation at the publication boundary", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "yt2sheet-cli-cancel-publication-"));
  const outputPath = join(directory, "score.pdf");
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  await writeFile(outputPath, "%PDF-prior", "utf8");
  const controller = new AbortController();

  await assert.rejects(runCliJob({
    videoId: "1yCkz9VT3ZA", videoUrl: "https://youtu.be/1yCkz9VT3ZA", outputPath, overwriteOutput: true,
    signal: controller.signal, tools, toolValidator: async () => undefined,
    processorFactory: ({ dataRoot }) => ({
      async process(): Promise<{ readonly filePath: string; readonly pageCount: number }> {
        const filePath = join(dataRoot, "result.pdf");
        await writeFile(filePath, "%PDF-new", "utf8");
        controller.abort();
        return { filePath, pageCount: 1 };
      }
    })
  }), (error: unknown) => error instanceof Error && error.name === "AbortError");

  assert.equal(await readFile(outputPath, "utf8"), "%PDF-prior");
  assert.deepEqual((await readdir(directory)).sort(), ["score.pdf"]);
});

test("preserves the prior PDF when the atomic rename fails", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "yt2sheet-cli-rename-failure-"));
  const outputPath = join(directory, "score.pdf");
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  await writeFile(outputPath, "%PDF-prior", "utf8");

  await assert.rejects(runCliJob({
    videoId: "1yCkz9VT3ZA", videoUrl: "https://youtu.be/1yCkz9VT3ZA", outputPath, overwriteOutput: true,
    publication: {
      rename: async () => {
        const error = new Error("injected rename failure");
        Object.assign(error, { code: "EIO" });
        throw error;
      }
    },
    tools, toolValidator: async () => undefined,
    processorFactory: ({ dataRoot }) => ({
      async process(): Promise<{ readonly filePath: string; readonly pageCount: number }> {
        const filePath = join(dataRoot, "result.pdf");
        await writeFile(filePath, "%PDF-new", "utf8");
        return { filePath, pageCount: 1 };
      }
    })
  }), { code: "PUBLICATION_FAILED" });

  assert.equal(await readFile(outputPath, "utf8"), "%PDF-prior");
  assert.deepEqual((await readdir(directory)).sort(), ["score.pdf"]);
});

test("propagates reviewed outcome and warnings without exposing a sidecar path", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "yt2sheet-cli-review-result-"));
  const outputPath = join(directory, "score.pdf");
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const warning = { pageNumber: 1, code: "OMR_UNAVAILABLE" as const, evidence: { tool: "audiveris", versionProbe: "missing" } };

  const result = await runCliJob({
    videoId: "1yCkz9VT3ZA", videoUrl: "https://youtu.be/1yCkz9VT3ZA", outputPath,
    tools, toolValidator: async () => undefined,
    processorFactory: ({ dataRoot }) => ({
      async process(): Promise<{ readonly filePath: string; readonly pageCount: number; readonly reviewOutcome: "raster-fallback"; readonly warnings: readonly [typeof warning] }> {
        const filePath = join(dataRoot, "result.pdf");
        await writeFile(filePath, "%PDF-review", "utf8");
        return { filePath, pageCount: 1, reviewOutcome: "raster-fallback", warnings: [warning] };
      }
    })
  });

  if (!("reviewOutcome" in result) || !("warnings" in result)) assert.fail("review outcome was not propagated");
  assert.equal(result.reviewOutcome, "raster-fallback");
  assert.deepEqual(result.warnings, [warning]);
  assert.equal(result.outputPath.endsWith(".json"), false);
  assert.equal(await readFile(outputPath, "utf8"), "%PDF-review");
});

test("blocked processor outcome leaves an existing output untouched", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "yt2sheet-cli-blocked-publication-"));
  const outputPath = join(directory, "score.pdf");
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  await writeFile(outputPath, "%PDF-prior", "utf8");

  await assert.rejects(runCliJob({
    videoId: "1yCkz9VT3ZA", videoUrl: "https://youtu.be/1yCkz9VT3ZA", outputPath, overwriteOutput: true,
    tools, toolValidator: async () => undefined,
    processorFactory: () => ({
      async process(): Promise<never> {
        throw new ScorePipelineError("RASTER_REVIEW_FAILED", "review blocked");
      }
    })
  }), { code: "RASTER_REVIEW_FAILED" });

  assert.equal(await readFile(outputPath, "utf8"), "%PDF-prior");
});
