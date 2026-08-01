import assert from "node:assert/strict";
import { watch } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { runProcess } from "../pipeline/media-tools";

it("rejects a pre-aborted process without spawning the executable", async () => {
  // Given: an already-cancelled signal and an executable that cannot exist.
  const signal = new TrackedAbortSignal();
  signal.abort();

  // When: process execution is requested.
  const rejection = assert.rejects(
    runProcess("yt2sheet-pre-abort-must-not-spawn.exe", [], { signal }),
    { name: "AbortError" }
  );

  // Then: cancellation wins before spawn and no listener is registered.
  await rejection;
  assert.deepEqual(signal.listenerCounts, { added: 0, removed: 0 });
});

it("removes the abort listener after process success", async () => {
  // Given: an observable cancellation signal.
  const signal = new TrackedAbortSignal();

  // When: a child process succeeds.
  const output = await runProcess(process.execPath, ["-e", "process.stdout.write('ok')"], { signal });

  // Then: its one abort listener is removed.
  assert.equal(output, "ok");
  assert.deepEqual(signal.listenerCounts, { added: 1, removed: 1 });
});

it("removes the abort listener after process failure", async () => {
  // Given: an observable cancellation signal.
  const signal = new TrackedAbortSignal();

  // When: a child process exits unsuccessfully.
  await assert.rejects(runProcess(process.execPath, ["-e", "process.exit(7)"], { signal }), /exit code 7/);

  // Then: its one abort listener is removed.
  assert.deepEqual(signal.listenerCounts, { added: 1, removed: 1 });
});

it("removes the abort listener after process timeout", async () => {
  // Given: an observable cancellation signal.
  const signal = new TrackedAbortSignal();

  // When: a child process exceeds its deadline.
  await assert.rejects(
    runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { signal, timeoutMs: 100 }),
    /Process timed out/
  );

  // Then: its one abort listener is removed.
  assert.deepEqual(signal.listenerCounts, { added: 1, removed: 1 });
});

it("preserves AbortError and removes the listener after cancellation", async () => {
  // Given: a running child and an observable cancellation signal.
  const signal = new TrackedAbortSignal();
  const result = runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { signal });

  // When: cancellation is requested after process setup.
  setImmediate(() => signal.abort());

  // Then: cancellation remains typed and its listener is removed.
  await assert.rejects(result, { name: "AbortError" });
  assert.deepEqual(signal.listenerCounts, { added: 1, removed: 1 });
});

it("terminates the complete process tree after cancellation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "yt2sheet-process-abort-tree-"));
  const childScript = join(directory, "child.mjs");
  const grandchildScript = join(directory, "grandchild.mjs");
  const pidFile = join(directory, "pids.json");
  let pids: { readonly parent: number; readonly grandchild: number } | undefined;
  const signal = new AbortController();

  await writeFile(grandchildScript, "setInterval(() => {}, 1000);\n");
  await writeFile(
    childScript,
    [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      "const [grandchildScript, pidFile] = process.argv.slice(2);",
      "const grandchild = spawn(process.execPath, [grandchildScript], { detached: process.platform === 'win32', stdio: 'ignore', windowsHide: true });",
      "grandchild.unref();",
      "writeFileSync(pidFile, JSON.stringify({ parent: process.pid, grandchild: grandchild.pid }));",
      "setInterval(() => {}, 1000);"
    ].join("\n")
  );

  try {
    const pidReported = waitForFileChange(directory, pidFile);
    const processResult = runProcess(process.execPath, [childScript, grandchildScript, pidFile], { signal: signal.signal });
    await pidReported;
    const parsedPids = parseProcessIds(await readFile(pidFile, "utf8"));
    pids = parsedPids;

    signal.abort();

    await assert.rejects(processResult, { name: "AbortError" });
    assert.equal(isProcessAlive(parsedPids.parent), false);
    assert.equal(isProcessAlive(parsedPids.grandchild), false);
  } finally {
    if (pids) {
      terminateIfAlive(pids.parent);
      terminateIfAlive(pids.grandchild);
    }
    await rm(directory, { recursive: true, force: true });
    t.diagnostic(JSON.stringify({ scenario: "abort-tree", directory, pids, processesAlive: false, tempRemoved: true }));
  }
});

it("terminates the complete process tree after a timeout", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "yt2sheet-process-tree-"));
  const childScript = join(directory, "child.mjs");
  const grandchildScript = join(directory, "grandchild.mjs");
  const pidFile = join(directory, "pids.json");
  let pids: { readonly parent: number; readonly grandchild: number } | undefined;

  await writeFile(grandchildScript, "setInterval(() => {}, 1000);\n");
  await writeFile(
    childScript,
    [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      "const [grandchildScript, pidFile] = process.argv.slice(2);",
      "const grandchild = spawn(process.execPath, [grandchildScript], { detached: process.platform === 'win32', stdio: 'ignore', windowsHide: true });",
      "grandchild.unref();",
      "writeFileSync(pidFile, JSON.stringify({ parent: process.pid, grandchild: grandchild.pid }));",
      "setInterval(() => {}, 1000);"
    ].join("\n")
  );

  try {
    await assert.rejects(
      runProcess(process.execPath, [childScript, grandchildScript, pidFile], { timeoutMs: 1_000 }),
      /Process timed out/
    );
    const parsedPids = parseProcessIds(await readFile(pidFile, "utf8"));
    pids = parsedPids;

    assert.equal(isProcessAlive(parsedPids.parent), false);
    assert.equal(isProcessAlive(parsedPids.grandchild), false);
    assert.equal(
      await runProcess(process.execPath, ["-e", "process.stdout.write('next-ok')"], { timeoutMs: 5_000 }),
      "next-ok"
    );
  } finally {
    if (pids) {
      terminateIfAlive(pids.parent);
      terminateIfAlive(pids.grandchild);
    }
    await rm(directory, { recursive: true, force: true });
    t.diagnostic(JSON.stringify({ scenario: "timeout-tree", directory, pids, processesAlive: false, tempRemoved: true }));
  }
});

function parseProcessIds(json: string): { readonly parent: number; readonly grandchild: number } {
  const value: unknown = JSON.parse(json);
  if (
    typeof value !== "object" ||
    value === null ||
    !("parent" in value) ||
    !("grandchild" in value) ||
    typeof value.parent !== "number" ||
    typeof value.grandchild !== "number"
  ) {
    throw new Error("Process tree did not report valid process ids.");
  }
  return { parent: value.parent, grandchild: value.grandchild };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNoSuchProcessError(error)) {
      return false;
    }
    throw error;
  }
}

function terminateIfAlive(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (!isNoSuchProcessError(error)) {
      throw error;
    }
  }
}

function isNoSuchProcessError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

function waitForFileChange(directory: string, expectedPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const watcher = watch(directory, (_event, filename) => {
      if (filename !== null && join(directory, String(filename)) === expectedPath) {
        watcher.close();
        clearTimeout(timer);
        resolve();
      }
    });
    const timer = setTimeout(() => {
      watcher.close();
      reject(new Error(`Timed out waiting for ${expectedPath}`));
    }, 5_000);
  });
}

class TrackedAbortSignal implements AbortSignal {
  private readonly controller = new AbortController();
  private added = 0;
  private removed = 0;

  get aborted(): boolean {
    return this.controller.signal.aborted;
  }

  get reason(): unknown {
    return this.controller.signal.reason;
  }

  get onabort(): ((this: AbortSignal, event: Event) => unknown) | null {
    return this.controller.signal.onabort;
  }

  set onabort(listener: ((this: AbortSignal, event: Event) => unknown) | null) {
    this.controller.signal.onabort = listener;
  }

  get listenerCounts(): { readonly added: number; readonly removed: number } {
    return { added: this.added, removed: this.removed };
  }

  abort(): void {
    this.controller.abort();
  }

  throwIfAborted(): void {
    this.controller.signal.throwIfAborted();
  }

  addEventListener<K extends keyof AbortSignalEventMap>(
    type: K,
    listener: (this: AbortSignal, event: AbortSignalEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ): void {
    this.added += 1;
    this.controller.signal.addEventListener(type, listener, options);
  }

  removeEventListener<K extends keyof AbortSignalEventMap>(
    type: K,
    listener: (this: AbortSignal, event: AbortSignalEventMap[K]) => unknown,
    options?: boolean | EventListenerOptions
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions
  ): void {
    this.removed += 1;
    this.controller.signal.removeEventListener(type, listener, options);
  }

  dispatchEvent(event: Event): boolean {
    return this.controller.signal.dispatchEvent(event);
  }
}
