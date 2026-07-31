import assert from "node:assert/strict";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";
import { runCliJob } from "../cli/job";

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
