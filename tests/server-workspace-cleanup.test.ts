import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs, { type PathLike } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createScoreJobApp } from "../server/app";
import { ScoreJobService } from "../server/score-job-service";
import {
  cleanupOwnedResultFiles,
  cleanupOwnedWorkDirectories,
  createOwnedWorkDirectoryName,
  shutdownScoreJobServer
} from "../server/workspace-cleanup";

const FIXTURE_RUN_ID = "00000000-0000-4000-8000-000000000000";

describe("startup workspace cleanup", () => {
  it("removes only owned work directories and preserves results and linked external data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yt2sheet-workspace-cleanup-"));
    const dataRoot = join(directory, "data");
    const orphanDirectory = join(dataRoot, "work", FIXTURE_RUN_ID);
    const unownedDirectory = join(dataRoot, "work", "user-managed");
    const resultPath = join(dataRoot, "results", "completed.pdf");
    const externalDirectory = join(directory, "external");
    const externalPath = join(externalDirectory, "sentinel.txt");
    const workFile = join(dataRoot, "work", "unowned.txt");
    const liveWorkDirectory = join(dataRoot, "work", createOwnedWorkDirectoryName(FIXTURE_RUN_ID));

    try {
      await Promise.all([
        mkdir(orphanDirectory, { recursive: true }),
        mkdir(unownedDirectory, { recursive: true }),
        mkdir(liveWorkDirectory, { recursive: true }),
        mkdir(join(dataRoot, "results"), { recursive: true }),
        mkdir(externalDirectory, { recursive: true })
      ]);
      await Promise.all([
        writeFile(join(orphanDirectory, "partial.bin"), "partial"),
        writeFile(join(unownedDirectory, "sentinel.bin"), "keep"),
        writeFile(join(liveWorkDirectory, "active.bin"), "active"),
        writeFile(resultPath, "%PDF-completed"),
        writeFile(externalPath, "outside"),
        writeFile(workFile, "keep")
      ]);
      await symlink(externalDirectory, join(dataRoot, "work", "linked-external"), process.platform === "win32" ? "junction" : "dir");

      await cleanupOwnedWorkDirectories(dataRoot);

      await assert.rejects(access(orphanDirectory));
      assert.equal(await readFile(join(unownedDirectory, "sentinel.bin"), "utf8"), "keep");
      assert.equal(await readFile(join(liveWorkDirectory, "active.bin"), "utf8"), "active");
      assert.equal(await readFile(resultPath, "utf8"), "%PDF-completed");
      assert.equal(await readFile(externalPath, "utf8"), "outside");
      assert.equal(await readFile(workFile, "utf8"), "keep");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves a live process workspace and removes it after the owner exits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yt2sheet-workspace-owner-"));
    const dataRoot = join(directory, "data");
    const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      shell: false,
      stdio: "ignore",
      windowsHide: true
    });
    assert.ok(owner.pid);
    const workDirectory = join(dataRoot, "work", createOwnedWorkDirectoryName(FIXTURE_RUN_ID, owner.pid));

    try {
      await mkdir(workDirectory, { recursive: true });
      await writeFile(join(workDirectory, "active.bin"), "active");

      await cleanupOwnedWorkDirectories(dataRoot);
      assert.equal(await readFile(join(workDirectory, "active.bin"), "utf8"), "active");

      owner.kill();
      await once(owner, "exit");
      await cleanupOwnedWorkDirectories(dataRoot);
      await assert.rejects(access(workDirectory));
    } finally {
      owner.kill();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts a missing work root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yt2sheet-workspace-missing-"));
    try {
      await cleanupOwnedWorkDirectories(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("removes dead-PID owned results while preserving current-PID and arbitrary files", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "yt2sheet-result-cleanup-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const dataRoot = join(directory, "data");
    const resultsRoot = join(dataRoot, "results");
    await mkdir(resultsRoot, { recursive: true });
    const deadOwner = spawn(process.execPath, ["-e", "process.exit(0)"], { windowsHide: true });
    assert.ok(deadOwner.pid);
    const deadPid = deadOwner.pid;
    await once(deadOwner, "exit");
    const deadResult = join(resultsRoot, ownedResultName(deadPid));
    const liveResult = join(resultsRoot, ownedResultName(process.pid));
    const arbitrary = join(resultsRoot, "user-managed.pdf");
    await Promise.all([
      writeFile(deadResult, "dead"),
      writeFile(liveResult, "live"),
      writeFile(arbitrary, "arbitrary")
    ]);

    await cleanupOwnedResultFiles(dataRoot);

    await assert.rejects(access(deadResult));
    assert.equal(await readFile(liveResult, "utf8"), "live");
    assert.equal(await readFile(arbitrary, "utf8"), "arbitrary");
  });

  it("removes a stale owned PDF result", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "yt2sheet-stale-pdf-cleanup-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const dataRoot = join(directory, "data");
    const resultsRoot = join(dataRoot, "results");
    await mkdir(resultsRoot, { recursive: true });
    const deadOwner = spawn(process.execPath, ["-e", "process.exit(0)"], { windowsHide: true });
    assert.ok(deadOwner.pid);
    const deadPid = deadOwner.pid;
    await once(deadOwner, "exit");
    const staleResult = join(resultsRoot, ownedResultName(deadPid));
    await writeFile(staleResult, "stale");

    await cleanupOwnedResultFiles(dataRoot);

    await assert.rejects(lstat(staleResult), { code: "ENOENT" });
  });

  it("removes a stale owned PDF result with its quality sidecar", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "yt2sheet-stale-sidecar-cleanup-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const dataRoot = join(directory, "data");
    const resultsRoot = join(dataRoot, "results");
    await mkdir(resultsRoot, { recursive: true });
    const deadOwner = spawn(process.execPath, ["-e", "process.exit(0)"], { windowsHide: true });
    assert.ok(deadOwner.pid);
    const deadPid = deadOwner.pid;
    await once(deadOwner, "exit");
    const staleResult = join(resultsRoot, ownedResultName(deadPid));
    const staleSidecar = `${staleResult}.quality.json`;
    const sentinelPdf = join(resultsRoot, "user-managed.pdf");
    const sentinelJson = join(resultsRoot, "user-managed.pdf.quality.json");
    const malformedSidecar = join(resultsRoot, `yt2sheet-result-p${deadPid}-malformed.pdf.quality.json`);
    await Promise.all([
      writeFile(staleResult, "stale"),
      writeFile(staleSidecar, "{\"quality\":0.9}"),
      writeFile(sentinelPdf, "sentinel"),
      writeFile(sentinelJson, "{\"sentinel\":true}"),
      writeFile(malformedSidecar, "{\"malformed\":true}")
    ]);

    await cleanupOwnedResultFiles(dataRoot);

    await assert.rejects(lstat(staleResult), { code: "ENOENT" });
    await assert.rejects(lstat(staleSidecar), { code: "ENOENT" });
    assert.equal((await lstat(sentinelPdf)).isFile(), true);
    assert.equal((await lstat(sentinelJson)).isFile(), true);
    assert.equal((await lstat(malformedSidecar)).isFile(), true);
  });

  it("preserves validated PDF and sidecar replacements while deleting an untouched stale pair", async (t) => {
    // Given: three stale dead-owner pairs and a deterministic lstat seam that replaces two candidates after validation.
    const directory = await mkdtemp(join(tmpdir(), "yt2sheet-startup-replacement-race-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const dataRoot = join(directory, "data");
    const resultsRoot = join(dataRoot, "results");
    await mkdir(resultsRoot, { recursive: true });
    const deadOwner = spawn(process.execPath, ["-e", "process.exit(0)"], { windowsHide: true });
    assert.ok(deadOwner.pid);
    const deadPid = deadOwner.pid;
    await once(deadOwner, "exit");
    const replacedPdf = join(resultsRoot, ownedResultName(deadPid, "123e4567-e89b-42d3-a456-426614174001"));
    const sidecarOwner = join(resultsRoot, ownedResultName(deadPid, "123e4567-e89b-42d3-a456-426614174002"));
    const replacedSidecar = `${sidecarOwner}.quality.json`;
    const untouchedPdf = join(resultsRoot, ownedResultName(deadPid, "123e4567-e89b-42d3-a456-426614174003"));
    const untouchedSidecar = `${untouchedPdf}.quality.json`;
    await Promise.all([
      writeFile(replacedPdf, "%PDF-owned"),
      writeFile(`${replacedPdf}.quality.json`, "owned-paired-sidecar"),
      writeFile(sidecarOwner, "%PDF-owned"),
      writeFile(replacedSidecar, "owned-sidecar"),
      writeFile(untouchedPdf, "%PDF-owned"),
      writeFile(untouchedSidecar, "owned-sidecar")
    ]);
    const replacementContents = new Map([
      [replacedPdf, "%PDF-replacement"],
      [replacedSidecar, "sidecar-replacement"]
    ]);
    const originalIdentities = new Map<string, { readonly device: string; readonly inode: string }>();
    const originalLstat = fs.promises.lstat.bind(fs.promises);
    t.mock.method(fs.promises, "lstat", async (path: PathLike) => {
      const stats = await originalLstat(path);
      if (typeof path === "string") {
        const replacementContent = replacementContents.get(path);
        if (replacementContent !== undefined && !originalIdentities.has(path)) {
          originalIdentities.set(path, { device: stats.dev.toString(), inode: stats.ino.toString() });
          await rename(path, `${path}.owned-original`);
          await writeFile(path, replacementContent);
        }
      }
      return stats;
    });

    // When: startup cleanup validates and then attempts to remove each stale pair.
    await cleanupOwnedResultFiles(dataRoot);

    // Then: replacements differ by identity and content, the PDF-gated sidecar remains, and the untouched pair is gone.
    for (const [path, expectedContent] of replacementContents) {
      const original = originalIdentities.get(path);
      assert.ok(original);
      const replacement = await originalLstat(path, { bigint: true });
      assert.notDeepEqual(
        [replacement.dev.toString(), replacement.ino.toString()],
        [original.device, original.inode]
      );
      assert.equal(await readFile(path, "utf8"), expectedContent);
      t.diagnostic(JSON.stringify({
        artifact: path === replacedPdf ? "startup-pdf" : "startup-sidecar",
        original,
        replacement: { device: replacement.dev.toString(), inode: replacement.ino.toString() },
        content: expectedContent
      }));
    }
    assert.equal(await readFile(`${replacedPdf}.quality.json`, "utf8"), "owned-paired-sidecar");
    await assert.rejects(originalLstat(sidecarOwner), { code: "ENOENT" });
    await assert.rejects(originalLstat(untouchedPdf), { code: "ENOENT" });
    await assert.rejects(originalLstat(untouchedSidecar), { code: "ENOENT" });
    t.diagnostic(JSON.stringify({ untouchedPairRemoved: true }));
  });

  it("removes an interrupted dead-owner quality sidecar temporary file while preserving similar paths", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "yt2sheet-stale-sidecar-temporary-cleanup-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const dataRoot = join(directory, "data");
    const resultsRoot = join(dataRoot, "results");
    await mkdir(resultsRoot, { recursive: true });
    const deadOwner = spawn(process.execPath, ["-e", "process.exit(0)"], { windowsHide: true });
    assert.ok(deadOwner.pid);
    const deadPid = deadOwner.pid;
    await once(deadOwner, "exit");
    const interruptedTemporary = join(resultsRoot, qualitySidecarTemporaryName(deadPid));
    const liveTemporary = join(resultsRoot, qualitySidecarTemporaryName(process.pid));
    const malformedTemporary = join(resultsRoot, `yt2sheet-result-p${deadPid}-malformed.pdf.quality.json.123e4567-e89b-42d3-a456-426614174000.tmp`);
    await Promise.all([
      writeFile(interruptedTemporary, "partial"),
      writeFile(liveTemporary, "live"),
      writeFile(malformedTemporary, "malformed")
    ]);

    await cleanupOwnedResultFiles(dataRoot);

    await assert.rejects(lstat(interruptedTemporary), { code: "ENOENT" });
    assert.equal(await readFile(liveTemporary, "utf8"), "live");
    assert.equal(await readFile(malformedTemporary, "utf8"), "malformed");
  });

  it("removes only legacy UUID results older than one hour", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "yt2sheet-legacy-cleanup-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const dataRoot = join(directory, "data");
    const resultsRoot = join(dataRoot, "results");
    await mkdir(resultsRoot, { recursive: true });
    const oldLegacy = join(resultsRoot, "123e4567-e89b-42d3-a456-426614174000.pdf");
    const freshLegacy = join(resultsRoot, "223e4567-e89b-42d3-a456-426614174000.pdf");
    const now = 4_000_000;
    await Promise.all([writeFile(oldLegacy, "old"), writeFile(freshLegacy, "fresh")]);
    await utimes(oldLegacy, new Date(now - 3_600_001), new Date(now - 3_600_001));
    await utimes(freshLegacy, new Date(now - 3_600_000), new Date(now - 3_600_000));

    await cleanupOwnedResultFiles(dataRoot, () => now);

    await assert.rejects(access(oldLegacy));
    assert.equal(await readFile(freshLegacy, "utf8"), "fresh");
  });

  it("rejects a results-root junction without touching external files", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "yt2sheet-result-root-link-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const dataRoot = join(directory, "data");
    const externalRoot = join(directory, "external");
    await Promise.all([mkdir(dataRoot), mkdir(externalRoot)]);
    const sentinel = join(externalRoot, ownedResultName(99_999_999));
    await writeFile(sentinel, "sentinel");
    await symlink(externalRoot, join(dataRoot, "results"), process.platform === "win32" ? "junction" : "dir");

    await assert.rejects(cleanupOwnedResultFiles(dataRoot), { name: "UnsafeWorkspaceError" });
    assert.equal(await readFile(sentinel, "utf8"), "sentinel");
  });

  it("runs result cleanup even when the work root is missing and old service ids disappear after restart", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "yt2sheet-restart-cleanup-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const dataRoot = join(directory, "data");
    const resultsRoot = join(dataRoot, "results");
    await mkdir(resultsRoot, { recursive: true });
    const deadOwner = spawn(process.execPath, ["-e", "process.exit(0)"], { windowsHide: true });
    assert.ok(deadOwner.pid);
    const deadPid = deadOwner.pid;
    await once(deadOwner, "exit");
    const remnant = join(resultsRoot, ownedResultName(deadPid));
    await writeFile(remnant, "remnant");

    await cleanupOwnedWorkDirectories(dataRoot);
    await cleanupOwnedResultFiles(dataRoot);

    await assert.rejects(access(remnant));
    const newService = new ScoreJobService({
      process: async () => ({ filePath: "unused.pdf", pageCount: 1 })
    }, { dataRoot });
    const restartedLookup = await createScoreJobApp(newService).request("http://localhost/api/score-jobs/old-job");
    assert.equal(restartedLookup.status, 404);
    assert.deepEqual(await restartedLookup.json(), {
      error: { code: "JOB_NOT_FOUND", message: "작업이 중단되었거나 만료되었습니다." }
    });
  });

  it("awaits service shutdown before closing the HTTP server", async () => {
    const order: string[] = [];
    const allowShutdown = deferred<void>();
    const shutdown = shutdownScoreJobServer({
      shutdown: async () => {
        order.push("service-start");
        await allowShutdown.promise;
        order.push("service-finished");
      }
    }, {
      close: (callback: (error?: Error) => void) => {
        order.push("http-close");
        callback();
      }
    });

    assert.deepEqual(order, ["service-start"]);
    allowShutdown.resolve();
    await shutdown;
    assert.deepEqual(order, ["service-start", "service-finished", "http-close"]);
  });
});

function ownedResultName(ownerPid: number, runId = "123e4567-e89b-42d3-a456-426614174000"): string {
  return `yt2sheet-result-p${ownerPid}-${runId}.pdf`;
}

function qualitySidecarTemporaryName(ownerPid: number): string {
  return `${ownedResultName(ownerPid)}.quality.json.123e4567-e89b-42d3-a456-426614174000.tmp`;
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve = (_value: T): void => {};
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
