import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
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

function ownedResultName(ownerPid: number): string {
  return `yt2sheet-result-p${ownerPid}-123e4567-e89b-42d3-a456-426614174000.pdf`;
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve = (_value: T): void => {};
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
