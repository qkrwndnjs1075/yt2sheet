import { spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
const OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024, WORKSPACE_LIMIT_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_SOURCE_PAGES = 100, WORKSPACE_POLL_MS = 25, KILL_GRACE_MS = 250;
export type ScoreTool = "audiveris" | "musescore";
export type ScoreToolWorkspace = { readonly root: string; readonly work: string; readonly config: string; readonly cache: string; readonly temporary: string };
export type ScoreToolRunRequest = {
  readonly tool: ScoreTool; readonly executable: string; readonly args: readonly string[]; readonly pageCount: number;
  readonly workspaceRoot?: string; readonly estimatedWorkspaceBytes?: number; readonly timeoutCeilingMs?: number;
  readonly workspaceBudgetCeilingBytes?: number; readonly signal?: AbortSignal;
  readonly collect?: (workspace: ScoreToolWorkspace) => Promise<unknown>;
};
export type ScoreToolErrorCode = "SCORE_TOOL_INVALID_REQUEST" | "SCORE_TOOL_PAGE_LIMIT" | "SCORE_TOOL_WORKSPACE_LIMIT" | "SCORE_TOOL_CANCELLED" | "SCORE_TOOL_TIMED_OUT" | "SCORE_TOOL_SPAWN_FAILED" | "SCORE_TOOL_EXIT_NONZERO" | "SCORE_TOOL_COLLECTION_FAILED" | "SCORE_TOOL_RUNTIME_FAILED" | "SCORE_TOOL_CLEANUP_FAILED";
type OutputDetails = { readonly stdout: string; readonly stderr: string; readonly stdoutTruncated: boolean; readonly stderrTruncated: boolean };
export type ScoreToolRunResult = OutputDetails & (
  | { readonly ok: true; readonly code: "SCORE_TOOL_OK"; readonly exitCode: 0; readonly value: unknown }
  | { readonly ok: false; readonly code: ScoreToolErrorCode; readonly exitCode: number | null }
);
type CapturedOutput = { readonly text: string; readonly truncated: boolean };
type ProcessExit = { readonly code: number | null; readonly spawnFailed: boolean };
let serializedTail: Promise<void> = Promise.resolve();
export function scoreToolTimeoutMs(tool: ScoreTool, pageCount: number): number {
  const minute = 60_000;
  return tool === "audiveris"
    ? Math.min(20 * minute, (2 * pageCount + 2) * minute)
    : Math.min(10 * minute, (pageCount + 1) * minute);
}
export async function runScoreTool(request: ScoreToolRunRequest): Promise<ScoreToolRunResult> {
  const invalidCode = validateRequest(request);
  if (invalidCode !== null) return emptyFailure(invalidCode);
  if (request.signal?.aborted) return emptyFailure("SCORE_TOOL_CANCELLED");
  let release: () => void = () => undefined;
  const predecessor = serializedTail;
  const slot = new Promise<void>((resolve) => {
    release = resolve;
  });
  serializedTail = predecessor.then(() => slot);
  if (!await waitForTurn(predecessor, request.signal)) {
    void predecessor.then(release);
    return emptyFailure("SCORE_TOOL_CANCELLED");
  }
  try {
    return await runIsolated(request);
  } finally {
    release();
  }
}
async function runIsolated(request: ScoreToolRunRequest): Promise<ScoreToolRunResult> {
  if (request.signal?.aborted) return emptyFailure("SCORE_TOOL_CANCELLED");
  const parent = request.workspaceRoot ?? tmpdir();
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "yt2sheet-score-tool-"));
  const workspace = { root, work: join(root, "work"), config: join(root, "config"), cache: join(root, "cache"), temporary: join(root, "tmp") };
  let result: ScoreToolRunResult;
  try {
    await Promise.all([workspace.work, workspace.config, workspace.cache, workspace.temporary].map((path) => mkdir(path, { recursive: true })));
    result = await execute(request, workspace);
  } catch (error) {
    result = emptyFailure("SCORE_TOOL_RUNTIME_FAILED", errorText(error));
  }
  try {
    await rm(root, { recursive: true, force: true });
  } catch (error) {
    return emptyFailure("SCORE_TOOL_CLEANUP_FAILED", errorText(error));
  }
  return result;
}
async function waitForTurn(predecessor: Promise<void>, signal?: AbortSignal): Promise<boolean> {
  if (signal === undefined) {
    await predecessor;
    return true;
  }
  let cancel: () => void = () => undefined;
  const aborted = new Promise<boolean>((resolve) => {
    cancel = () => resolve(false);
  });
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const acquired = await Promise.race([predecessor.then(() => true), aborted]);
  signal.removeEventListener("abort", cancel);
  return acquired;
}
async function execute(request: ScoreToolRunRequest, workspace: ScoreToolWorkspace): Promise<ScoreToolRunResult> {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let termination: ScoreToolErrorCode | null = null;
  let terminationPromise: Promise<void> | null = null;
  const child = spawn(request.executable, [...request.args], {
    cwd: workspace.work,
    detached: process.platform !== "win32",
    env: isolatedEnvironment(workspace),
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const closed = childExit(child);
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength;
    appendChunk(stdoutChunks, chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    appendChunk(stderrChunks, chunk);
  });
  const stop = (code: ScoreToolErrorCode): void => {
    if (termination !== null) return;
    termination = code;
    terminationPromise = terminateProcessTree(child, closed);
  };
  const abort = (): void => stop("SCORE_TOOL_CANCELLED");
  request.signal?.addEventListener("abort", abort, { once: true });
  const timeoutMs = Math.min(scoreToolTimeoutMs(request.tool, request.pageCount), request.timeoutCeilingMs ?? Number.MAX_SAFE_INTEGER);
  const timeout = setTimeout(() => stop("SCORE_TOOL_TIMED_OUT"), timeoutMs);
  const budget = Math.min(WORKSPACE_LIMIT_BYTES, request.workspaceBudgetCeilingBytes ?? WORKSPACE_LIMIT_BYTES);
  let checkingWorkspace = false;
  let workspaceCheck = Promise.resolve();
  const workspacePoll = setInterval(() => {
    if (termination !== null || checkingWorkspace) return;
    checkingWorkspace = true;
    workspaceCheck = directoryBytes(workspace.root).then((bytes) => {
      if (bytes > budget && child.exitCode === null) stop("SCORE_TOOL_WORKSPACE_LIMIT");
    }).finally(() => {
      checkingWorkspace = false;
    });
  }, WORKSPACE_POLL_MS);
  const exit = await closed;
  if (terminationPromise !== null) await terminationPromise;
  clearTimeout(timeout);
  clearInterval(workspacePoll);
  await workspaceCheck;
  request.signal?.removeEventListener("abort", abort);
  const stdout = captured(stdoutChunks, stdoutBytes);
  const stderr = captured(stderrChunks, stderrBytes);
  if (termination !== null) return failure(termination, exit.code, stdout, stderr);
  if (exit.spawnFailed) return failure("SCORE_TOOL_SPAWN_FAILED", null, stdout, stderr);
  if (exit.code !== 0) return failure("SCORE_TOOL_EXIT_NONZERO", exit.code, stdout, stderr);
  if (await directoryBytes(workspace.root) > budget) return failure("SCORE_TOOL_WORKSPACE_LIMIT", 0, stdout, stderr);
  let value: unknown;
  try {
    value = request.collect ? await request.collect(workspace) : undefined;
  } catch (error) {
    return failure("SCORE_TOOL_COLLECTION_FAILED", 0, stdout, { text: errorText(error), truncated: false });
  }
  return { ok: true, code: "SCORE_TOOL_OK", exitCode: 0, stdout: stdout.text, stderr: stderr.text, stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated, value };
}
function validateRequest(request: ScoreToolRunRequest): ScoreToolErrorCode | null {
  if ((request.tool !== "audiveris" && request.tool !== "musescore") || typeof request.executable !== "string" || !Array.isArray(request.args) || request.args.some((arg) => typeof arg !== "string")) return "SCORE_TOOL_INVALID_REQUEST";
  if (!Number.isInteger(request.pageCount) || request.pageCount < 1) return "SCORE_TOOL_INVALID_REQUEST";
  if (request.pageCount > MAX_SOURCE_PAGES) return "SCORE_TOOL_PAGE_LIMIT";
  if (!isAbsolute(request.executable) || request.executable.includes("\0") || isNetworkArgument(request.executable)) return "SCORE_TOOL_INVALID_REQUEST";
  if (request.args.some((arg) => arg.includes("\0") || isNetworkArgument(arg))) return "SCORE_TOOL_INVALID_REQUEST";
  if (request.workspaceRoot !== undefined && (!isAbsolute(request.workspaceRoot) || isNetworkArgument(request.workspaceRoot))) return "SCORE_TOOL_INVALID_REQUEST";
  const estimate = request.estimatedWorkspaceBytes ?? 0;
  const budget = Math.min(WORKSPACE_LIMIT_BYTES, request.workspaceBudgetCeilingBytes ?? WORKSPACE_LIMIT_BYTES);
  if (!Number.isSafeInteger(estimate) || estimate < 0) return "SCORE_TOOL_INVALID_REQUEST";
  if (!Number.isSafeInteger(budget) || budget < 1) return "SCORE_TOOL_INVALID_REQUEST";
  if (request.timeoutCeilingMs !== undefined && (!Number.isSafeInteger(request.timeoutCeilingMs) || request.timeoutCeilingMs < 1)) return "SCORE_TOOL_INVALID_REQUEST";
  return estimate > budget ? "SCORE_TOOL_WORKSPACE_LIMIT" : null;
}
function isNetworkArgument(argument: string): boolean {
  return /(?:[a-z][a-z0-9+.-]*:\/\/|www\.|youtube\.com|youtu\.be|^\\\\|^\/\/)/iu.test(argument);
}
function isolatedEnvironment(workspace: ScoreToolWorkspace): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: workspace.config, USERPROFILE: workspace.config, XDG_CONFIG_HOME: workspace.config, XDG_CACHE_HOME: workspace.cache, TMPDIR: workspace.temporary, TMP: workspace.temporary, TEMP: workspace.temporary };
  for (const name of ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"] as const) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}
function childExit(child: ChildProcess): Promise<ProcessExit> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exit: ProcessExit): void => {
      if (settled) return;
      settled = true;
      resolve(exit);
    };
    child.once("error", () => finish({ code: null, spawnFailed: true }));
    child.once("close", (code) => finish({ code, spawnFailed: false }));
  });
}
async function terminateProcessTree(child: ChildProcess, closed: Promise<ProcessExit>): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore" });
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      killer.once("error", () => {
        child.kill();
        finish();
      });
      killer.once("close", finish);
    });
    await closed;
    return;
  }
  signalGroup(pid, "SIGTERM");
  await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, KILL_GRACE_MS))]);
  if (child.exitCode === null) signalGroup(pid, "SIGKILL");
  await closed;
}
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error.code === "ESRCH" || error.code === "EPERM"))) throw error;
  }
}
function appendChunk(chunks: Buffer[], chunk: Buffer): void {
  const retained = chunks.reduce((total, item) => total + item.byteLength, 0);
  if (retained >= OUTPUT_LIMIT_BYTES) return;
  chunks.push(chunk.subarray(0, OUTPUT_LIMIT_BYTES - retained));
}
function captured(chunks: readonly Buffer[], receivedBytes: number): CapturedOutput {
  return { text: Buffer.concat(chunks).toString("utf8"), truncated: receivedBytes > OUTPUT_LIMIT_BYTES };
}
async function directoryBytes(path: string): Promise<number> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    const sizes = await Promise.all(entries.map(async (entry) => {
      const childPath = join(path, entry.name);
      if (entry.isDirectory()) return directoryBytes(childPath);
      if (!entry.isFile()) return 0;
      return Number((await lstat(childPath)).size);
    }));
    return sizes.reduce((total, size) => total + size, 0);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
    throw error;
  }
}
function failure(code: ScoreToolErrorCode, exitCode: number | null, stdout: CapturedOutput, stderr: CapturedOutput): ScoreToolRunResult {
  return { ok: false, code, exitCode, stdout: stdout.text, stderr: stderr.text, stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated };
}
function emptyFailure(code: ScoreToolErrorCode, stderr = ""): ScoreToolRunResult {
  return { ok: false, code, exitCode: null, stdout: "", stderr, stdoutTruncated: false, stderrTruncated: false };
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
