import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { join, resolve } from "node:path";
import { parseCliArguments } from "../cli/arguments";
import { runCliJob } from "../cli/job";
import type { ScoreJobInput } from "../pipeline/job-contract";
import type { ResolvedScoreTimeRange } from "../pipeline/score-time-range";

test("runs a processor and copies only its PDF to the requested path", async () => {
  let dataRoot = "";
  let receivedCookiesPath = "";

  const result = await runCliJob({
    videoId: "1yCkz9VT3ZA",
    videoUrl: "https://youtu.be/1yCkz9VT3ZA",
    outputPath: "build-test/cli-output/test-score.pdf",
    cookiesPath: "build-test/cli-output/cookies.txt",
    tools: {
      ytDlp: process.execPath,
      ffmpeg: process.execPath,
      ffprobe: process.execPath
    },
    toolValidator: async () => undefined,
    processorFactory: (options) => {
      dataRoot = options.dataRoot;
      receivedCookiesPath = options.tools.ytDlpCookiesPath ?? "";
      return {
        async process(): Promise<{ readonly filePath: string; readonly pageCount: number }> {
          const filePath = resolve(dataRoot, "result.pdf");
          await writeFile(filePath, "%PDF-test", "utf8");
          return { filePath, pageCount: 2 };
        }
      };
    }
  });

  assert.equal(result.pageCount, 2);
  assert.equal(receivedCookiesPath, resolve("build-test/cli-output/cookies.txt"));
  assert.equal(await readFile(result.outputPath, "utf8"), "%PDF-test");
  await access(result.outputPath);
  await assert.rejects(stat(dataRoot), { code: "ENOENT" });
});

test("preserves an existing default output by allocating a numbered PDF", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "yt2sheet-cli-output-"));
  const outputPath = join(directory, "yt2sheet-1yCkz9VT3ZA.pdf");
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  await writeFile(outputPath, "%PDF-first", "utf8");

  const result = await runCliJob({
    videoId: "1yCkz9VT3ZA",
    videoUrl: "https://youtu.be/1yCkz9VT3ZA",
    outputPath,
    tools: { ytDlp: process.execPath, ffmpeg: process.execPath, ffprobe: process.execPath },
    toolValidator: async () => undefined,
    processorFactory: ({ dataRoot }) => ({
      async process(): Promise<{ readonly filePath: string; readonly pageCount: number }> {
        const filePath = join(dataRoot, "result.pdf");
        await writeFile(filePath, "%PDF-second", "utf8");
        return { filePath, pageCount: 2 };
      }
    })
  });

  assert.equal(result.outputPath, join(directory, "yt2sheet-1yCkz9VT3ZA-2.pdf"));
  assert.equal(await readFile(outputPath, "utf8"), "%PDF-first");
  assert.equal(await readFile(result.outputPath, "utf8"), "%PDF-second");
});

test("replaces an explicit output path", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "yt2sheet-cli-explicit-output-"));
  const outputPath = join(directory, "score.pdf");
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  await writeFile(outputPath, "%PDF-first", "utf8");

  const result = await runCliJob({
    videoId: "1yCkz9VT3ZA",
    videoUrl: "https://youtu.be/1yCkz9VT3ZA",
    outputPath,
    overwriteOutput: true,
    tools: { ytDlp: process.execPath, ffmpeg: process.execPath, ffprobe: process.execPath },
    toolValidator: async () => undefined,
    processorFactory: ({ dataRoot }) => ({
      async process(): Promise<{ readonly filePath: string; readonly pageCount: number }> {
        const filePath = join(dataRoot, "result.pdf");
        await writeFile(filePath, "%PDF-second", "utf8");
        return { filePath, pageCount: 2 };
      }
    })
  });

  assert.equal(result.outputPath, outputPath);
  assert.equal(await readFile(outputPath, "utf8"), "%PDF-second");
});

test("forwards an optional time range to the processor input without adding an absent key", async () => {
  const observedInputs: ScoreJobInput[] = [];
  const parsedCommands = [
    parseCliArguments(["https://youtu.be/1yCkz9VT3ZA"], "C:/work"),
    parseCliArguments(["--start=12.5", "https://youtu.be/1yCkz9VT3ZA"], "C:/work"),
    parseCliArguments(["--end=30", "https://youtu.be/1yCkz9VT3ZA"], "C:/work"),
    parseCliArguments(["--start=12.5", "--end=30", "https://youtu.be/1yCkz9VT3ZA"], "C:/work")
  ];

  for (const parsed of parsedCommands) {
    assert.equal(parsed.kind, "ok");
    if (parsed.kind !== "ok") throw new Error("expected a runnable CLI command");
    const jobOptions = {
      ...parsed.command,
      outputPath: "build-test/cli-output/time-range.pdf",
      tools: {
        ytDlp: process.execPath,
        ffmpeg: process.execPath,
        ffprobe: process.execPath
      },
      toolValidator: async () => undefined,
      processorFactory: ({ dataRoot }: { readonly dataRoot: string }) => ({
        async process(input: ScoreJobInput): Promise<{ readonly filePath: string; readonly pageCount: number }> {
          observedInputs.push(input);
          const filePath = resolve(dataRoot, "result.pdf");
          await writeFile(filePath, "%PDF-test", "utf8");
          return { filePath, pageCount: 1 };
        }
      })
    };

    await runCliJob(jobOptions);
  }

  assert.deepEqual(observedInputs, [
    { videoId: "1yCkz9VT3ZA", videoUrl: "https://youtu.be/1yCkz9VT3ZA" },
    { videoId: "1yCkz9VT3ZA", videoUrl: "https://youtu.be/1yCkz9VT3ZA", timeRange: { startTimeSec: 12.5 } },
    { videoId: "1yCkz9VT3ZA", videoUrl: "https://youtu.be/1yCkz9VT3ZA", timeRange: { endTimeSec: 30 } },
    {
      videoId: "1yCkz9VT3ZA",
      videoUrl: "https://youtu.be/1yCkz9VT3ZA",
      timeRange: { startTimeSec: 12.5, endTimeSec: 30 }
    }
  ]);
});

test("forwards the resolved-range callback through the CLI job context", async () => {
  const observedRanges: ResolvedScoreTimeRange[] = [];
  const resolvedRange: ResolvedScoreTimeRange = {
    kind: "explicit",
    startTimeSec: 83.5,
    endTimeSec: 3723,
    sampleDurationSec: 3639.5,
    hasStartBound: true,
    hasEndBound: true
  };

  await runCliJob({
    videoId: "1yCkz9VT3ZA",
    videoUrl: "https://youtu.be/1yCkz9VT3ZA",
    outputPath: "build-test/cli-output/time-range-callback.pdf",
    overwriteOutput: true,
    onTimeRangeResolved: (range) => observedRanges.push(range),
    tools: { ytDlp: process.execPath, ffmpeg: process.execPath, ffprobe: process.execPath },
    toolValidator: async () => undefined,
    processorFactory: ({ dataRoot }) => ({
      async process(_input: ScoreJobInput, context): Promise<{ readonly filePath: string; readonly pageCount: number }> {
        context.onTimeRangeResolved?.(resolvedRange);
        const filePath = resolve(dataRoot, "result.pdf");
        await writeFile(filePath, "%PDF-test", "utf8");
        return { filePath, pageCount: 1 };
      }
    })
  });

  assert.deepEqual(observedRanges, [resolvedRange]);
});
