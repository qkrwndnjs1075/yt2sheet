import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createProductionApp } from "../server/web-app";
import { ScoreJobService } from "../server/score-job-service";

describe("single-server web app", () => {
  it("serves built web files and API routes from the same Hono app", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "yt2sheet-web-app-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const webRoot = join(directory, "dist-web");
    const indexContents = "<!doctype html><html><body>yt2sheet</body></html>";
    const assetContents = "console.log('yt2sheet');";
    await mkdir(join(webRoot, "assets"), { recursive: true });
    await writeFile(join(webRoot, "index.html"), indexContents);
    await writeFile(join(webRoot, "assets", "app.js"), assetContents);

    const service = new ScoreJobService({
      process: async () => ({ filePath: "unused.pdf", pageCount: 1 })
    });
    const app = createProductionApp(service, webRoot);

    const page = await app.request("http://localhost/");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(await page.text(), indexContents);

    const asset = await app.request("http://localhost/assets/app.js");
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type") ?? "", /javascript/);
    assert.equal(await asset.text(), assetContents);

    const health = await app.request("http://localhost/api/health");
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });

    const missing = await app.request("http://localhost/missing");
    assert.equal(missing.status, 404);
  });
});
