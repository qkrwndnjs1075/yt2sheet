import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { transcribeAudiverisPages } from "../pipeline/audiveris-adapter";
import { audiverisFixture, readInvocations, setVersionDelay, setVersionStderr, waitForInvocationCount } from "./support/audiveris-adapter-fixture";

it("rejects zero, duplicate, and traversal MXL outputs without exposing candidates", async (t) => {
  // Given: tools that emit zero candidates, two candidates, or one candidate outside the output directory.
  const cases = [
    ["zero", "mxl-output-count-0"],
    ["extra", "mxl-output-count-2"],
    ["traversal", "mxl-output-outside-directory"]
  ] as const;

  // When: each untrusted output shape crosses the adapter collection boundary.
  const outcomes = [];
  for (const [mode] of cases) {
    const fixture = await audiverisFixture(t, [mode]);
    outcomes.push([await transcribeAudiverisPages(fixture.request), await readdir(fixture.workspaceRoot)] as const);
  }

  // Then: each becomes exact fallback evidence, exposes no bytes/path, and leaves no task workspace.
  for (const [index, [result, residue]] of outcomes.entries()) {
    assert.equal(result.kind, "raster-fallback");
    if (result.kind !== "raster-fallback") continue;
    assert.deepEqual(result.warning, { pageNumber: 1, code: "OMR_FAILED", evidence: { exitCode: 0, logSummary: cases[index]?.[1] } });
    assert.equal("pages" in result, false);
    assert.deepEqual(residue, ["audiveris-output", "stale.txt"]);
  }
});

it("maps wrong version and unsafe MXL to exact fallback evidence", async (t) => {
  // Given: a wrong-version executable and a process that writes a malformed MXL archive.
  const wrongVersion = await audiverisFixture(t, ["valid"], "5.11.0-malicious");
  const unsafe = await audiverisFixture(t, ["invalid"]);

  // When: both candidates pass through version and archive validation boundaries.
  const [wrongVersionResult, unsafeResult] = await Promise.all([
    transcribeAudiverisPages(wrongVersion.request),
    transcribeAudiverisPages(unsafe.request)
  ]);

  // Then: neither yields structured bytes and the stable warning class identifies its boundary.
  assert.equal(wrongVersionResult.kind, "raster-fallback");
  if (wrongVersionResult.kind === "raster-fallback") {
    assert.equal(wrongVersionResult.warning.code, "OMR_UNAVAILABLE");
    assert.deepEqual(Object.keys(wrongVersionResult.warning.evidence).sort(), ["tool", "versionProbe"]);
  }
  assert.deepEqual(unsafeResult, { kind: "raster-fallback", warning: { pageNumber: 1, code: "MXL_UNSAFE", evidence: { reason: "end-of-central-directory" } } });
});

it("rejects a split-channel version probe with conflicting stderr", async (t) => {
  // Given: a malicious probe that prints the pinned version on stdout and a conflicting version on stderr.
  const fixture = await audiverisFixture(t, ["valid"]);
  await setVersionStderr(fixture, "5.10.0");

  // When: the executable is probed before page transcription.
  const result = await transcribeAudiverisPages(fixture.request);

  // Then: the ambiguous tool is unavailable, no candidate is exposed, and no page command runs.
  assert.equal(result.kind, "raster-fallback");
  if (result.kind === "raster-fallback") {
    assert.equal(result.warning.code, "OMR_UNAVAILABLE");
    assert.deepEqual(Object.keys(result.warning.evidence).sort(), ["tool", "versionProbe"]);
    assert.match(String(result.warning.evidence.versionProbe), /^expected=5\.11\.0,stdout=[a-f0-9]{64},stderr=[a-f0-9]{64}$/u);
    assert.equal(String(result.warning.evidence.versionProbe).includes("5.10.0"), false);
  }
  assert.deepEqual(await readInvocations(fixture.invocationPath), [["-version"]]);
  assert.equal("pages" in result, false);
});

it("maps timeout, cancellation, and misleading nonzero output without leaking logs", async (t) => {
  // Given: separate hanging, cancellable, and misleading nonzero fake executables.
  const timed = await audiverisFixture(t, ["hang"]);
  const cancelled = await audiverisFixture(t, ["hang"]);
  const nonzero = await audiverisFixture(t, ["nonzero"]);
  const controller = new AbortController();

  // When: the first times out, the second is cancelled after spawn, and the third exits seven.
  const timedResult = await transcribeAudiverisPages({ ...timed.request, timeoutCeilingMs: 1_000 });
  const cancellation = transcribeAudiverisPages({ ...cancelled.request, signal: controller.signal, timeoutCeilingMs: 5_000 });
  t.after(async () => {
    controller.abort();
    await cancellation;
  });
  await waitForInvocationCount(cancelled.invocationPath, 2);
  controller.abort();
  const [cancelledResult, nonzeroResult] = await Promise.all([cancellation, transcribeAudiverisPages(nonzero.request)]);

  // Then: stable warning evidence wins over child output and every isolated workspace is removed.
  assert.deepEqual(timedResult, { kind: "raster-fallback", warning: { pageNumber: 1, code: "OMR_TIMEOUT", evidence: { timeoutMs: 1_000 } } });
  assert.equal(cancelledResult.kind, "raster-fallback");
  if (cancelledResult.kind === "raster-fallback") assert.equal(cancelledResult.warning.evidence.exitCode, "SCORE_TOOL_CANCELLED");
  assert.equal(nonzeroResult.kind, "raster-fallback");
  if (nonzeroResult.kind === "raster-fallback") {
    assert.equal(nonzeroResult.warning.evidence.exitCode, 7);
    assert.equal(String(nonzeroResult.warning.evidence.logSummary).includes("IGNORE SAFETY"), false);
    assert.equal(String(nonzeroResult.warning.evidence.logSummary).includes("private/path"), false);
  }
  assert.deepEqual(await Promise.all([timed, cancelled, nonzero].map(({ workspaceRoot }) => readdir(workspaceRoot))), [
    ["audiveris-output", "stale.txt"],
    ["audiveris-output", "stale.txt"],
    ["audiveris-output", "stale.txt"]
  ]);
  const cancelledInvocations = await readInvocations(cancelled.invocationPath);
  assert.equal(cancelledInvocations.length, 2);
  t.diagnostic(JSON.stringify({ scenario: "audiveris-failure-harness", timedResult, cancelledResult, nonzeroResult, cancelledInvocationCount: cancelledInvocations.length }));
});

it("preserves the first source page lineage when the Audiveris probe times out", async (t) => {
  // Given: an approved first page and a pinned executable whose version probe exceeds the request ceiling.
  const fixture = await audiverisFixture(t, ["valid"]);
  await setVersionDelay(fixture, 2_000);
  const requestSnapshot = JSON.stringify(fixture.request.pages);

  // When: the probe times out before any page command can start.
  const result = await transcribeAudiverisPages({ ...fixture.request, timeoutCeilingMs: 1_000 });

  // Then: the fallback retains the affected source page and the caller-owned lineage remains unchanged.
  const invocations = await readInvocations(fixture.invocationPath);
  const residue = await readdir(fixture.workspaceRoot);
  t.diagnostic(JSON.stringify({ scenario: "audiveris-probe-timeout-lineage", requestPageNumber: fixture.request.pages[0]?.lineage.pageNumber, result, invocations, residue, requestUnchanged: JSON.stringify(fixture.request.pages) === requestSnapshot }));
  assert.deepEqual(invocations, [["-version"]]);
  assert.deepEqual(residue, ["audiveris-output", "stale.txt"]);
  assert.equal(JSON.stringify(fixture.request.pages), requestSnapshot);
  assert.deepEqual(result, { kind: "raster-fallback", warning: { pageNumber: 1, code: "OMR_TIMEOUT", evidence: { timeoutMs: 1_000 } } });
});

it("rejects malformed page names and nonmonotonic lineage before spawning Audiveris", async (t) => {
  // Given: an approved-page request whose second lineage repeats page one.
  const fixture = await audiverisFixture(t, ["valid", "valid"]);
  const first = fixture.request.pages[0];
  const second = fixture.request.pages[1];
  if (first === undefined || second === undefined) throw new TypeError("fixture pages absent");
  const request = { ...fixture.request, pages: [first, { ...second, lineage: { ...second.lineage, pageNumber: 1 } }] };

  // When: the request crosses the page-lineage boundary.
  const result = await transcribeAudiverisPages(request);

  // Then: exact mismatch evidence is returned before any executable invocation.
  assert.deepEqual(result, { kind: "raster-fallback", warning: { pageNumber: 1, code: "STRUCTURED_LINEAGE_MISMATCH", evidence: { expectedPageNumber: 2, actualPageNumber: 2 } } });
  await assert.rejects(() => readdir(fixture.invocationPath), { code: "ENOENT" });
});

it("rejects malformed page paths and a missing manifest executable before candidate output", async (t) => {
  // Given: one malformed page name and one request whose manifest-resolved executable is absent.
  const malformed = await audiverisFixture(t, ["valid"]);
  const missingTool = await audiverisFixture(t, ["valid"]);
  const page = malformed.request.pages[0];
  if (page === undefined) throw new TypeError("fixture page absent");

  // When: the malformed page and missing runtime independently cross the adapter boundary.
  const [malformedResult, missingToolResult] = await Promise.all([
    transcribeAudiverisPages({ ...malformed.request, pages: [{ ...page, path: join(dirname(page.path), "score.png") }] }),
    transcribeAudiverisPages({ ...missingTool.request, runtimeRoot: join(missingTool.request.runtimeRoot, "absent") })
  ]);

  // Then: neither request exposes a candidate and each reports its exact fallback class.
  assert.deepEqual(malformedResult, { kind: "raster-fallback", warning: { pageNumber: 1, code: "STRUCTURED_LINEAGE_MISMATCH", evidence: { expectedPageNumber: 1, actualPageNumber: 0 } } });
  assert.deepEqual(missingToolResult, { kind: "raster-fallback", warning: { pageNumber: 1, code: "OMR_UNAVAILABLE", evidence: { tool: "audiveris", versionProbe: "SCORE_TOOL_SPAWN_FAILED" } } });
});
