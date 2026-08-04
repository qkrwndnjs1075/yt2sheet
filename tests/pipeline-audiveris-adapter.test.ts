import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { it } from "node:test";
import { transcribeAudiverisPages } from "../pipeline/audiveris-adapter";
import { validateMxl } from "../pipeline/musicxml-validator";
import { audiverisFixture, readInvocations, sha256 } from "./support/audiveris-adapter-fixture";

it("transcribes two approved pages in order with exact Audiveris argv and lineage", async (t) => {
  // Given: two ordered approved A4 pages and a manifest-staged deterministic Audiveris executable.
  const fixture = await audiverisFixture(t, ["valid", "valid"]);

  // When: both pages are transcribed through the real isolated process runner.
  const result = await transcribeAudiverisPages(fixture.request);

  // Then: the probe and page commands are exact, and both safe MXL records preserve order and provenance.
  assert.equal(result.kind, "structured");
  if (result.kind !== "structured") return;
  const invocations = await readInvocations(fixture.invocationPath);
  assert.deepEqual(invocations, [
    ["-version"],
    ["-batch", "-export", "-output", "audiveris-output", "--", fixture.request.pages[0]?.path],
    ["-batch", "-export", "-output", "audiveris-output", "--", fixture.request.pages[1]?.path]
  ]);
  assert.deepEqual(result.pages.map(({ pageNumber, lineage }) => [pageNumber, lineage]), fixture.request.pages.map(({ lineage }) => [lineage.pageNumber, lineage]));
  assert.deepEqual(result.pages.map(({ version, exitCode }) => [version, exitCode]), [["5.11.0", 0], ["5.11.0", 0]]);
  assert.deepEqual(result.pages.map(({ inputSha256 }) => inputSha256), await Promise.all(fixture.request.pages.map(async ({ path }) => sha256(await readFile(path)))));
  assert.deepEqual(result.pages.map(({ outputSha256 }) => outputSha256), [sha256(fixture.validMxl), sha256(fixture.validMxl)]);
  assert.equal(result.pages.every(({ durationMs }) => Number.isSafeInteger(durationMs) && durationMs >= 0), true);
  assert.equal(result.pages.every(({ logSummary }) => !logSummary.includes("IGNORE SAFETY") && !logSummary.includes("private/path")), true);
  assert.deepEqual(await Promise.all(result.pages.map(({ mxl }) => validateMxl(mxl))), [
    { format: "mxl", root: "score-partwise" },
    { format: "mxl", root: "score-partwise" }
  ]);
  assert.deepEqual(await readdir(fixture.workspaceRoot), ["audiveris-output", "stale.txt"]);
});
