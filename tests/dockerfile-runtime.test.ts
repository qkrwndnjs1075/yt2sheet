import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

describe("runtime Docker image", () => {
  it("keeps tsx available for the start:server command", async () => {
    const dockerfile = await readFile(resolve(process.cwd(), "Dockerfile"), "utf8");
    const runtimeStage = dockerfile.match(/FROM node:22-bookworm-slim AS runtime[\s\S]*$/)?.[0] ?? "";

    assert.match(
      runtimeStage,
      /RUN npm ci --include=dev\b/,
      "the runtime image must install tsx from devDependencies for start:server"
    );
    assert.match(
      runtimeStage,
      /pip install --no-cache-dir ["']yt-dlp\[default\]["']/,
      "the runtime image must install yt-dlp EJS dependencies"
    );
    assert.match(
      runtimeStage,
      /ENV YT_DLP_JS_RUNTIME=node\b/,
      "the runtime image must enable Node for yt-dlp JavaScript challenges"
    );
  });
});
