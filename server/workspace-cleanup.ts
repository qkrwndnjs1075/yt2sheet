import { lstat, mkdir, readdir, realpath, rm, unlink } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { ScoreJobService } from "./score-job-service";

const OWNED_WORK_DIRECTORY = /^worker-(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEGACY_WORK_DIRECTORY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OWNED_RESULT_FILE = /^yt2sheet-result-p([1-9][0-9]*)-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pdf$/i;
const LEGACY_RESULT_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pdf$/i;
const LEGACY_RESULT_MAX_AGE_MS = 60 * 60 * 1_000;

type CloseableServer = {
  close(callback: (error?: Error) => void): void;
};

export class UnsafeWorkspaceError extends Error {
  constructor(readonly path: string) {
    super(`Unsafe workspace path: ${path}`);
    this.name = "UnsafeWorkspaceError";
  }
}

export function createOwnedWorkDirectoryName(runId: string, ownerPid = process.pid): string {
  return `worker-${ownerPid}-${runId}`;
}

export async function cleanupOwnedWorkDirectories(dataRoot: string): Promise<void> {
  const workRoot = resolve(dataRoot, "work");
  let rootStats;
  try {
    rootStats = await lstat(workRoot);
  } catch (error) {
    if (isMissingPathError(error)) {
      return;
    }
    throw error;
  }

  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    return;
  }

  const boundary = `${workRoot}${sep}`;
  for (const entry of await readdir(workRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }
    const ownerPid = parseOwnerPid(entry.name);
    if (ownerPid !== null && isProcessAlive(ownerPid)) {
      continue;
    }
    if (ownerPid === null && !LEGACY_WORK_DIRECTORY.test(entry.name)) {
      continue;
    }
    const ownedPath = resolve(workRoot, entry.name);
    if (ownedPath.startsWith(boundary)) {
      await rm(ownedPath, { recursive: true, force: true });
    }
  }
}

export async function cleanupOwnedResultFiles(dataRoot: string, now: () => number = Date.now): Promise<void> {
  const resultsRoot = await ensureSafeResultsRoot(dataRoot);
  for (const entry of await readdir(resultsRoot, { withFileTypes: true })) {
    const ownerPid = parseResultOwnerPid(entry.name);
    const isLegacy = ownerPid === null && LEGACY_RESULT_FILE.test(entry.name);
    if (ownerPid === null && !isLegacy) {
      continue;
    }
    if (ownerPid !== null && isProcessAlive(ownerPid)) {
      continue;
    }

    const candidate = resolve(resultsRoot, entry.name);
    const stats = await lstat(candidate);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      continue;
    }
    const resolvedCandidate = await realpath(candidate);
    if (dirname(resolvedCandidate) !== resultsRoot) {
      continue;
    }
    if (isLegacy && now() - stats.mtimeMs <= LEGACY_RESULT_MAX_AGE_MS) {
      continue;
    }
    await unlink(candidate);
  }
}

export async function shutdownScoreJobServer(
  service: Pick<ScoreJobService, "shutdown">,
  server: CloseableServer
): Promise<void> {
  await service.shutdown();
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error === undefined ? resolveClose() : rejectClose(error));
  });
}

async function ensureSafeResultsRoot(dataRoot: string): Promise<string> {
  const absoluteDataRoot = resolve(dataRoot);
  await mkdir(absoluteDataRoot, { recursive: true });
  const realDataRoot = await realpath(absoluteDataRoot);
  const expectedResultsRoot = resolve(realDataRoot, "results");
  try {
    await mkdir(expectedResultsRoot);
  } catch (error) {
    if (!isAlreadyExistsError(error)) {
      throw error;
    }
  }
  const stats = await lstat(expectedResultsRoot);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new UnsafeWorkspaceError(expectedResultsRoot);
  }
  const resolvedResultsRoot = await realpath(expectedResultsRoot);
  if (resolvedResultsRoot !== expectedResultsRoot) {
    throw new UnsafeWorkspaceError(expectedResultsRoot);
  }
  return resolvedResultsRoot;
}

function parseOwnerPid(directoryName: string): number | null {
  const match = OWNED_WORK_DIRECTORY.exec(directoryName);
  if (!match) {
    return null;
  }
  const ownerPid = Number(match[1]);
  return Number.isSafeInteger(ownerPid) && ownerPid > 0 ? ownerPid : null;
}

function parseResultOwnerPid(fileName: string): number | null {
  const match = OWNED_RESULT_FILE.exec(fileName);
  if (!match) {
    return null;
  }
  const ownerPid = Number(match[1]);
  return Number.isSafeInteger(ownerPid) && ownerPid > 0 ? ownerPid : null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
