import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { MusicXmlValidationError, validateMxl } from "./musicxml-validator";
import type { ScoreReviewDecisionInput } from "./score-review-contract";
import type { ScoreRuntimeManifest } from "./score-runtime-manifest";
import { runScoreTool, scoreToolTimeoutMs, type ScoreToolRunResult, type ScoreToolWorkspace } from "./score-tool-runner";

const AUDIVERIS_VERSION = "5.11.0" as const;
const OUTPUT_DIRECTORY = "audiveris-output" as const;
const PAGE_NAME = /^page-(\d{4})\.png$/;

export type AudiverisPageLineage = {
  readonly pageNumber: number;
  readonly sourceFrameIds: readonly string[];
  readonly sourceScoreIds: readonly string[];
};

export type AudiverisApprovedPage = {
  readonly path: string;
  readonly lineage: AudiverisPageLineage;
};

export type AudiverisPageMxl = {
  readonly pageNumber: number;
  readonly lineage: AudiverisPageLineage;
  readonly inputSha256: string;
  readonly outputSha256: string;
  readonly version: typeof AUDIVERIS_VERSION;
  readonly durationMs: number;
  readonly exitCode: 0;
  readonly logSummary: string;
  readonly mxl: Uint8Array;
};

export type AudiverisResult =
  | { readonly kind: "structured"; readonly pages: readonly AudiverisPageMxl[] }
  | { readonly kind: "raster-fallback"; readonly warning: ScoreReviewDecisionInput };

export type AudiverisRequest = {
  readonly manifest: ScoreRuntimeManifest;
  readonly platformId: ScoreRuntimeManifest["platforms"][number]["id"];
  readonly runtimeRoot: string;
  readonly workspaceRoot: string;
  readonly pages: readonly AudiverisApprovedPage[];
  readonly rasterSafe: true;
  readonly timeoutCeilingMs?: number;
  readonly signal?: AbortSignal;
};

type CollectedMxl = {
  readonly bytes: Uint8Array;
  readonly sha256: string;
};

class AudiverisCollectionError extends Error {
  readonly name = "AudiverisCollectionError";
}

export async function transcribeAudiverisPages(request: AudiverisRequest): Promise<AudiverisResult> {
  const pageWarning = await validatePages(request.pages);
  if (pageWarning !== null) return fallback(pageWarning);
  const platform = request.manifest.platforms.find(({ id }) => id === request.platformId);
  if (platform === undefined || !isAbsolute(request.runtimeRoot)) {
    return unavailable("manifest-executable-unresolved");
  }
  const runtime = platform.runtimes.audiveris;
  const executable = resolve(request.runtimeRoot, runtime.stagedExecutable);
  if (!isWithin(request.runtimeRoot, executable)) return unavailable("manifest-executable-unsafe");
  const probe = await runScoreTool({
    tool: "audiveris",
    executable,
    args: runtime.versionProbe.args,
    pageCount: request.pages.length,
    workspaceRoot: request.workspaceRoot,
    timeoutCeilingMs: request.timeoutCeilingMs,
    signal: request.signal
  });
  if (!probe.ok) return fallback(toolWarning(probe, null, request));
  const stdoutVersion = probe.stdout.trim();
  const stderrVersion = probe.stderr.trim();
  if (runtime.versionProbe.expected !== AUDIVERIS_VERSION || stdoutVersion !== AUDIVERIS_VERSION || stderrVersion.length !== 0) {
    return unavailable(`expected=${AUDIVERIS_VERSION},stdout=${probeDigest(stdoutVersion)},stderr=${probeDigest(stderrVersion)}`);
  }
  const pages: AudiverisPageMxl[] = [];
  for (const page of request.pages) {
    const input = await readFile(page.path);
    const started = performance.now();
    const run = await runScoreTool({
      tool: "audiveris",
      executable,
      args: ["-batch", "-export", "-output", OUTPUT_DIRECTORY, "--", page.path],
      pageCount: request.pages.length,
      workspaceRoot: request.workspaceRoot,
      timeoutCeilingMs: request.timeoutCeilingMs,
      signal: request.signal,
      collect: collectMxl
    });
    const durationMs = Math.max(0, Math.round(performance.now() - started));
    if (!run.ok) return fallback(toolWarning(run, page.lineage.pageNumber, request));
    if (!isCollectedMxl(run.value)) {
      return fallback(failed(page.lineage.pageNumber, 0, "collection-result-invalid"));
    }
    try {
      await validateMxl(run.value.bytes);
    } catch (error) {
      if (error instanceof MusicXmlValidationError) {
        return fallback(validationWarning(page.lineage.pageNumber, error));
      }
      throw error;
    }
    pages.push({
      pageNumber: page.lineage.pageNumber,
      lineage: page.lineage,
      inputSha256: sha256(input),
      outputSha256: run.value.sha256,
      version: AUDIVERIS_VERSION,
      durationMs,
      exitCode: 0,
      logSummary: summarizeLogs(run),
      mxl: Uint8Array.from(run.value.bytes)
    });
  }
  return { kind: "structured", pages };
}

async function validatePages(pages: readonly AudiverisApprovedPage[]): Promise<ScoreReviewDecisionInput | null> {
  if (pages.length < 1 || pages.length > 100) return lineageWarning(null, 1, pages.length);
  for (const [index, page] of pages.entries()) {
    const expected = index + 1;
    const match = PAGE_NAME.exec(basename(page.path));
    const actual = match === null ? 0 : Number(match[1]);
    if (page.lineage.pageNumber !== expected || actual !== expected || !safeLocalAbsolutePath(page.path)) {
      return lineageWarning(page.lineage.pageNumber, expected, actual);
    }
    try {
      const details = await lstat(page.path);
      if (!details.isFile() || details.isSymbolicLink()) return failed(page.lineage.pageNumber, "input", "input-not-regular");
    } catch (error) {
      if (error instanceof Error && "code" in error) return failed(page.lineage.pageNumber, "input", "input-unavailable");
      throw error;
    }
  }
  return null;
}

async function collectMxl(workspace: ScoreToolWorkspace): Promise<CollectedMxl> {
  const outputRoot = join(workspace.work, OUTPUT_DIRECTORY);
  const candidates: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new AudiverisCollectionError("output-symlink");
      if (entry.isDirectory()) await visit(path);
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".mxl")) candidates.push(path);
    }
  };
  await visit(workspace.work);
  if (candidates.length !== 1) throw new AudiverisCollectionError(`mxl-output-count-${candidates.length}`);
  const candidate = candidates[0];
  if (candidate === undefined || !isWithin(outputRoot, candidate)) throw new AudiverisCollectionError("mxl-output-outside-directory");
  const bytes = await readFile(candidate);
  return { bytes: Uint8Array.from(bytes), sha256: sha256(bytes) };
}

function toolWarning(run: ScoreToolRunResult, pageNumber: number | null, request: AudiverisRequest): ScoreReviewDecisionInput {
  switch (run.code) {
    case "SCORE_TOOL_TIMED_OUT":
      return { pageNumber, code: "OMR_TIMEOUT", evidence: { timeoutMs: Math.min(scoreToolTimeoutMs("audiveris", request.pages.length), request.timeoutCeilingMs ?? Number.MAX_SAFE_INTEGER) } };
    case "SCORE_TOOL_SPAWN_FAILED":
    case "SCORE_TOOL_INVALID_REQUEST":
      return { pageNumber, code: "OMR_UNAVAILABLE", evidence: { tool: "audiveris", versionProbe: run.code } };
    case "SCORE_TOOL_COLLECTION_FAILED":
      return failed(pageNumber, run.exitCode ?? 0, /^(?:mxl-output-count-\d+|mxl-output-outside-directory|output-symlink)$/u.test(run.stderr) ? run.stderr : "collection-failed");
    case "SCORE_TOOL_OK":
      return failed(pageNumber, 0, "unexpected-success");
    case "SCORE_TOOL_PAGE_LIMIT":
    case "SCORE_TOOL_WORKSPACE_LIMIT":
    case "SCORE_TOOL_CANCELLED":
    case "SCORE_TOOL_EXIT_NONZERO":
    case "SCORE_TOOL_RUNTIME_FAILED":
    case "SCORE_TOOL_CLEANUP_FAILED":
      return failed(pageNumber, run.exitCode ?? run.code, summarizeLogs(run));
    default:
      return assertNever(run);
  }
}

function validationWarning(pageNumber: number, error: MusicXmlValidationError): ScoreReviewDecisionInput {
  return error.code === "MXL_UNSAFE"
    ? { pageNumber, code: "MXL_UNSAFE", evidence: { reason: error.reason } }
    : { pageNumber, code: "MUSICXML_INVALID", evidence: { validationReason: error.reason } };
}

function unavailable(versionProbe: string): AudiverisResult {
  return fallback({ pageNumber: null, code: "OMR_UNAVAILABLE", evidence: { tool: "audiveris", versionProbe } });
}

function failed(pageNumber: number | null, exitCode: number | string, logSummary: string): ScoreReviewDecisionInput {
  return { pageNumber, code: "OMR_FAILED", evidence: { exitCode, logSummary } };
}

function lineageWarning(pageNumber: number | null, expected: number, actual: number): ScoreReviewDecisionInput {
  return { pageNumber, code: "STRUCTURED_LINEAGE_MISMATCH", evidence: { expectedPageNumber: expected, actualPageNumber: actual } };
}

function fallback(warning: ScoreReviewDecisionInput): AudiverisResult {
  return { kind: "raster-fallback", warning };
}

function summarizeLogs(run: ScoreToolRunResult): string {
  return `stdoutBytes=${Buffer.byteLength(run.stdout)},stderrBytes=${Buffer.byteLength(run.stderr)},stdoutTruncated=${run.stdoutTruncated},stderrTruncated=${run.stderrTruncated}`;
}

function isCollectedMxl(value: unknown): value is CollectedMxl {
  return typeof value === "object" && value !== null && "bytes" in value && value.bytes instanceof Uint8Array && "sha256" in value && typeof value.sha256 === "string";
}

function safeLocalAbsolutePath(path: string): boolean {
  return isAbsolute(path) && !path.includes("\0") && !/^(?:\\\\|\/\/)/u.test(path) && !/(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/iu.test(path);
}

function isWithin(root: string, path: string): boolean {
  const delta = relative(resolve(root), resolve(path));
  return delta !== ".." && !delta.startsWith(`..${sep}`) && !isAbsolute(delta);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function probeDigest(value: string): string {
  return value.length === 0 ? "empty" : sha256(Buffer.from(value));
}

function assertNever(value: never): never {
  throw new TypeError(`unexpected score tool result: ${String(value)}`);
}
