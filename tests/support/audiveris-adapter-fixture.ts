import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { strToU8, zipSync } from "fflate";
import type { AudiverisRequest } from "../../pipeline/audiveris-adapter";
import { loadScoreRuntimeManifest } from "../../pipeline/score-runtime-manifest";

const PLATFORM_ID = "macos-14-arm64" as const;

export type AudiverisFixture = {
  readonly request: AudiverisRequest;
  readonly workspaceRoot: string;
  readonly invocationPath: string;
  readonly validMxl: Uint8Array;
};

export async function audiverisFixture(t: TestContext, modes: readonly string[], version = "5.11.0"): Promise<AudiverisFixture> {
  const root = await mkdtemp(join(tmpdir(), "yt2sheet-audiveris-adapter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = await loadScoreRuntimeManifest();
  const platform = manifest.platforms.find(({ id }) => id === PLATFORM_ID);
  if (platform === undefined) throw new TypeError("fixture platform absent");
  const runtimeRoot = join(root, "runtime");
  const executable = join(runtimeRoot, platform.runtimes.audiveris.stagedExecutable);
  await mkdir(dirname(executable), { recursive: true });
  const fakeTool = await readFile(join(process.cwd(), "tests", "fixtures", "audiveris-adapter", "fake-audiveris.cjs"), "utf8");
  await writeFile(executable, fakeTool.replace("#!/usr/bin/env node", `#!${process.execPath}`));
  await chmod(executable, 0o755);
  await writeFile(join(dirname(executable), "version.txt"), version);
  const score = await readFile(join(process.cwd(), "tests", "fixtures", "musicxml-validator", "minimal-partwise.musicxml"));
  const validMxl = zipSync({
    "META-INF/container.xml": strToU8('<?xml version="1.0"?><container><rootfiles><rootfile full-path="score.musicxml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>'),
    "score.musicxml": score
  }, { level: 6, mtime: new Date("1980-01-01T00:00:00.000Z") });
  await writeFile(join(dirname(executable), "valid.mxl"), validMxl);
  const pageRoot = join(root, "pages");
  const workspaceRoot = join(root, "workspaces");
  await Promise.all([mkdir(pageRoot), mkdir(workspaceRoot)]);
  await writeFile(join(workspaceRoot, "stale.txt"), "preserve");
  await mkdir(join(workspaceRoot, "audiveris-output"));
  await writeFile(join(workspaceRoot, "audiveris-output", "stale.mxl"), "must-not-collect");
  const pages = await Promise.all(modes.map(async (mode, index) => {
    const pageNumber = index + 1;
    const path = join(pageRoot, `page-${String(pageNumber).padStart(4, "0")}.png`);
    await writeFile(path, mode);
    return { path, lineage: { pageNumber, sourceFrameIds: [`frame-${pageNumber}`], sourceScoreIds: [`score-${pageNumber}`] } };
  }));
  return {
    request: { manifest, platformId: PLATFORM_ID, runtimeRoot, workspaceRoot, pages, rasterSafe: true },
    workspaceRoot,
    invocationPath: join(dirname(executable), "invocations.jsonl"),
    validMxl
  };
}

export async function readInvocations(path: string): Promise<readonly (readonly string[])[]> {
  const source = await readFile(path, "utf8");
  return source.trim().split("\n").map((line) => {
    const value: unknown = JSON.parse(line);
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new TypeError("invalid invocation fixture log");
    return value;
  });
}

export async function setVersionStderr(fixture: AudiverisFixture, value: string): Promise<void> {
  const platform = fixture.request.manifest.platforms.find(({ id }) => id === fixture.request.platformId);
  if (platform === undefined) throw new TypeError("fixture platform absent");
  await writeFile(join(dirname(join(fixture.request.runtimeRoot, platform.runtimes.audiveris.stagedExecutable)), "version-stderr.txt"), value);
}

export function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function waitForInvocationCount(path: string, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await readInvocations(path)).length >= count) return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new TypeError(`fixture invocation count did not reach ${count}`);
}
