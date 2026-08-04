import assert from "node:assert/strict";
import { watch } from "node:fs";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { runScoreTool, scoreToolTimeoutMs, type ScoreToolRunRequest, type ScoreToolRunResult } from "../pipeline/score-tool-runner";
it("computes the bounded Audiveris and MuseScore deadlines from page count", () => {
  // Given: representative page counts at and beyond each deadline cap.
  const pageCounts = [1, 9, 10, 100] as const;
  // When: each tool deadline is derived.
  const audiveris = pageCounts.map((pageCount) => scoreToolTimeoutMs("audiveris", pageCount));
  const musescore = pageCounts.map((pageCount) => scoreToolTimeoutMs("musescore", pageCount));
  // Then: the documented linear formulas and hard caps are exact.
  assert.deepEqual(audiveris, [4, 20, 20, 20].map((minutes) => minutes * 60_000));
  assert.deepEqual(musescore, [2, 10, 10, 10].map((minutes) => minutes * 60_000));
});
it("passes exact argv in an isolated workspace and removes only the task directory", async (t) => {
  // Given: a stale sibling, unicode arguments, and an inherited config sentinel.
  const workspaceRoot = await fixtureRoot(t, "yt2sheet-score-tool-happy-");
  await writeFile(join(workspaceRoot, "stale.txt"), "keep");
  const originalHome = process.env.HOME;
  process.env.SCORE_TOOL_MUST_NOT_INHERIT = "secret";
  const script = [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'fs.writeFileSync("artifact.txt", "collected");',
    'process.stdout.write(JSON.stringify({ argv: process.argv.slice(1), cwd: process.cwd(), env: process.env }));'
  ].join("");
  // When: the executable runs and its output is collected before cleanup.
  const result = await runScoreTool({
    tool: "audiveris",
    executable: process.execPath,
    args: ["-e", script, "path with spaces", "악보.mxl"],
    pageCount: 1,
    workspaceRoot,
    collect: async (workspace) => ({ artifact: await readFile(join(workspace.work, "artifact.txt"), "utf8"), root: workspace.root })
  });
  delete process.env.SCORE_TOOL_MUST_NOT_INHERIT;
  // Then: argv is unmodified, config paths are task-owned, and cleanup preserves the sibling.
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const observed = parseRecord(result.stdout);
  const env = recordValue(observed, "env");
  assert.deepEqual(observed.argv, ["path with spaces", "악보.mxl"]);
  assert.equal(env.SCORE_TOOL_MUST_NOT_INHERIT, undefined);
  assert.equal(env.HOME, env.XDG_CONFIG_HOME);
  assert.equal(normalizeTemporaryPath(dirname(stringValue(env, "HOME"))), normalizeTemporaryPath(dirname(stringValue(observed, "cwd"))));
  assert.equal(process.env.HOME, originalHome);
  assert.equal(stringValue(parseRecord(JSON.stringify(result.value)), "artifact"), "collected");
  assert.equal(normalizeTemporaryPath(stringValue(parseRecord(JSON.stringify(result.value)), "root")), normalizeTemporaryPath(dirname(stringValue(observed, "cwd"))));
  assert.deepEqual(await readdir(workspaceRoot), ["stale.txt"]);
});
it("bounds stdout and stderr independently at exactly two MiB", async (t) => {
  // Given: a local executable that emits beyond both stream caps.
  const workspaceRoot = await fixtureRoot(t, "yt2sheet-score-tool-output-");
  const script = "process.stdout.write(Buffer.alloc(2097275, 65)); process.stderr.write(Buffer.alloc(2097275, 66));";
  // When: the process completes successfully.
  const result = await runNode(workspaceRoot, script);
  // Then: both retained buffers are bounded and explicitly marked truncated.
  assert.equal(result.ok, true);
  assert.equal(Buffer.byteLength(result.stdout), 2 * 1024 * 1024);
  assert.equal(Buffer.byteLength(result.stderr), 2 * 1024 * 1024);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, true);
});
it("treats a nonzero exit as failure even when stdout claims success", async (t) => {
  // Given: a misleading tool that prints success and exits seven.
  const workspaceRoot = await fixtureRoot(t, "yt2sheet-score-tool-exit-");
  // When: the tool terminates.
  const result = await runNode(workspaceRoot, 'process.stdout.write("success"); process.exit(7);');
  // Then: the stable failure code and actual exit status win.
  assert.deepEqual(result, { ok: false, code: "SCORE_TOOL_EXIT_NONZERO", exitCode: 7, stdout: "success", stderr: "", stdoutTruncated: false, stderrTruncated: false });
});
it("rejects malformed, network, page, and estimated disk inputs before creating a task directory", async (t) => {
  // Given: boundary-invalid requests covering each preflight class.
  const workspaceRoot = await fixtureRoot(t, "yt2sheet-score-tool-invalid-");
  const requests: readonly [ScoreToolRunRequest, string][] = [
    [{ tool: "audiveris", executable: "node", args: [], pageCount: 1, workspaceRoot }, "SCORE_TOOL_INVALID_REQUEST"],
    [{ tool: "audiveris", executable: "//server/share/audiveris.exe", args: [], pageCount: 1, workspaceRoot }, "SCORE_TOOL_INVALID_REQUEST"],
    [{ tool: "audiveris", executable: "\\\\server\\share\\audiveris.exe", args: [], pageCount: 1, workspaceRoot }, "SCORE_TOOL_INVALID_REQUEST"],
    [{ tool: "audiveris", executable: process.execPath, args: ["https://example.com/x"], pageCount: 1, workspaceRoot }, "SCORE_TOOL_INVALID_REQUEST"],
    [{ tool: "audiveris", executable: process.execPath, args: [], pageCount: 101, workspaceRoot }, "SCORE_TOOL_PAGE_LIMIT"],
    [{ tool: "musescore", executable: process.execPath, args: [], pageCount: 1, workspaceRoot, estimatedWorkspaceBytes: 4 * 1024 * 1024 * 1024 + 1 }, "SCORE_TOOL_WORKSPACE_LIMIT"]
  ];
  // When: each request crosses the runner boundary.
  const results = await Promise.all(requests.map(([request]) => runScoreTool(request)));
  // Then: stable codes are returned without workspace residue.
  assert.deepEqual(results.map((result) => result.code), requests.map(([, code]) => code));
  assert.deepEqual(await readdir(workspaceRoot), []);
});
it("enforces one active score tool globally", async (t) => {
  // Given: two tools that fail if their critical sections overlap.
  const workspaceRoot = await fixtureRoot(t, "yt2sheet-score-tool-serial-");
  const lock = join(workspaceRoot, "exclusive.lock");
  const script = 'const fs=require("node:fs"); const lock=process.argv[1]; const fd=fs.openSync(lock,"wx"); setTimeout(()=>{fs.closeSync(fd);fs.unlinkSync(lock);},100);';
  // When: both runs are submitted concurrently.
  const results = await Promise.all([runNode(workspaceRoot, script, [lock]), runNode(workspaceRoot, script, [lock])]);
  // Then: neither observes an overlapping external process.
  assert.deepEqual(results.map((result) => result.code), ["SCORE_TOOL_OK", "SCORE_TOOL_OK"]);
  assert.deepEqual(await readdir(workspaceRoot), []);
});
it("cancels a queued run without spawning it or releasing the active slot", async (t) => {
  // Given: an active tool held by an event-controlled local fixture.
  const workspaceRoot = await fixtureRoot(t, "yt2sheet-score-tool-queued-");
  const readyFile = join(workspaceRoot, "ready");
  const releaseFile = join(workspaceRoot, "release");
  const spawnedFile = join(workspaceRoot, "queued-spawned");
  const ready = waitForFile(workspaceRoot, readyFile);
  const active = runNode(workspaceRoot, 'const fs=require("node:fs");const ready=process.argv[1],release=process.argv[2];fs.writeFileSync(ready,"");const timer=setInterval(()=>{if(fs.existsSync(release)){clearInterval(timer);}},10);', [readyFile, releaseFile], { timeoutCeilingMs: 5_000 });
  await ready;
  const controller = new AbortController();
  const queued = runNode(workspaceRoot, 'require("node:fs").writeFileSync(process.argv[1],"");', [spawnedFile], { signal: controller.signal });

  // When: only the queued request is cancelled.
  controller.abort();
  const cancelled = await queued;
  await writeFile(releaseFile, "go");
  const completed = await active;

  // Then: cancellation returns before spawning and the active process completes normally.
  assert.equal(cancelled.code, "SCORE_TOOL_CANCELLED");
  assert.equal(completed.code, "SCORE_TOOL_OK");
  assert.deepEqual(await readdir(workspaceRoot), ["ready", "release"]);
});
it("times out and kills a child process tree before removing its workspace", async (t) => {
  // Given: a child that spawns a hanging grandchild and reports both PIDs.
  const workspaceRoot = await fixtureRoot(t, "yt2sheet-score-tool-timeout-");
  const pidFile = join(workspaceRoot, "timeout-pids.json");
  const ready = waitForFile(workspaceRoot, pidFile);
  // When: the bounded deadline expires.
  const pending = runNode(workspaceRoot, processTreeScript(), [pidFile], { timeoutCeilingMs: 200 });
  await ready;
  const pids = parsePids(await readFile(pidFile, "utf8"));
  const result = await pending;
  // Then: timeout is stable, both processes are gone, and only the receipt remains.
  assert.equal(result.code, "SCORE_TOOL_TIMED_OUT");
  assert.equal(isAlive(pids.parent), false);
  assert.equal(isAlive(pids.grandchild), false);
  assert.deepEqual(await readdir(workspaceRoot), ["timeout-pids.json"]);
});
it("handles repeated cancellation, kills the process tree, and permits a resumed run", async (t) => {
  // Given: a hanging process tree and a reusable serialized runner.
  const workspaceRoot = await fixtureRoot(t, "yt2sheet-score-tool-cancel-");
  const pidFile = join(workspaceRoot, "cancel-pids.json");
  const controller = new AbortController();
  const ready = waitForFile(workspaceRoot, pidFile);
  const pending = runNode(workspaceRoot, processTreeScript(), [pidFile], { signal: controller.signal });
  await ready;
  const pids = parsePids(await readFile(pidFile, "utf8"));
  // When: cancellation is repeated and a benign run follows it.
  controller.abort();
  controller.abort();
  const cancelled = await pending;
  const resumed = await runNode(workspaceRoot, 'process.stdout.write("resumed");');
  // Then: cancellation is stable, the tree is dead, and serialization resumes cleanly.
  assert.equal(cancelled.code, "SCORE_TOOL_CANCELLED");
  assert.equal(isAlive(pids.parent), false);
  assert.equal(isAlive(pids.grandchild), false);
  assert.equal(resumed.code, "SCORE_TOOL_OK");
  assert.equal(resumed.stdout, "resumed");
  assert.deepEqual(await readdir(workspaceRoot), ["cancel-pids.json"]);
});
it("rejects a task that exceeds its lowered test budget and cleans the workspace", async (t) => {
  // Given: a tool that creates a file larger than the enforced task budget.
  const workspaceRoot = await fixtureRoot(t, "yt2sheet-score-tool-budget-");
  // When: the command writes two KiB under a one KiB ceiling.
  const result = await runNode(workspaceRoot, 'require("node:fs").writeFileSync("large.bin", Buffer.alloc(2048));', [], { workspaceBudgetCeilingBytes: 1024 });
  // Then: disk exhaustion has a stable code and leaves no task directory.
  assert.equal(result.code, "SCORE_TOOL_WORKSPACE_LIMIT");
  assert.deepEqual(await readdir(workspaceRoot), []);
});
it("reports a missing absolute executable with a stable spawn code", async (t) => {
  // Given: a valid absolute path that has no executable.
  const workspaceRoot = await fixtureRoot(t, "yt2sheet-score-tool-spawn-");
  // When: process creation fails.
  const result = await runScoreTool({ tool: "musescore", executable: join(workspaceRoot, "missing-tool"), args: [], pageCount: 1, workspaceRoot });
  // Then: spawn failure is canonical and the task workspace is removed.
  assert.equal(result.code, "SCORE_TOOL_SPAWN_FAILED");
  assert.deepEqual(await readdir(workspaceRoot), []);
});
async function fixtureRoot(t: { after(callback: () => Promise<void>): void }, prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
function runNode(root: string, script: string, args: readonly string[] = [], options: Partial<ScoreToolRunRequest> = {}): Promise<ScoreToolRunResult> {
  return runScoreTool({ tool: "musescore", executable: process.execPath, args: ["-e", script, ...args], pageCount: 1, workspaceRoot: root, ...options });
}
function processTreeScript(): string {
  return 'const fs=require("node:fs"),cp=require("node:child_process"); const file=process.argv[1]; const gc=cp.spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); fs.writeFileSync(file,JSON.stringify({parent:process.pid,grandchild:gc.pid,workspace:process.cwd()})); setInterval(()=>{},1000);';
}
function parseRecord(json: string): Record<string, unknown> {
  const value: unknown = JSON.parse(json);
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}
function recordValue(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return parseRecord(JSON.stringify(record[key]));
}
function stringValue(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  assert.equal(typeof value, "string");
  return typeof value === "string" ? value : "";
}
function normalizeTemporaryPath(value: string): string {
  return value.replace(/^\/private(?=\/var\/)/u, "");
}
function parsePids(json: string): { readonly parent: number; readonly grandchild: number } {
  const value = parseRecord(json);
  assert.equal(typeof value.parent, "number");
  assert.equal(typeof value.grandchild, "number");
  if (typeof value.parent !== "number" || typeof value.grandchild !== "number") throw new TypeError("Invalid PID fixture");
  return { parent: value.parent, grandchild: value.grandchild };
}
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}
function waitForFile(directory: string, expectedPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const watcher = watch(directory, (_event, filename) => {
      if (filename === null || join(directory, String(filename)) !== expectedPath) return;
      watcher.close();
      clearTimeout(timer);
      resolve();
    });
    const timer = setTimeout(() => {
      watcher.close();
      reject(new Error(`Timed out waiting for ${expectedPath}`));
    }, 5_000);
  });
}
