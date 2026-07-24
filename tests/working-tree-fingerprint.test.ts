import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

type FingerprintEntry = {
  readonly mode: string;
  readonly path: string;
  readonly sha256: string;
  readonly status: "tracked" | "untracked";
  readonly type: "absent" | "directory" | "file" | "symlink";
};

type FingerprintManifest = {
  readonly entries: readonly FingerprintEntry[];
  readonly sha256: string;
  readonly version: 1;
};

const fingerprintScript = resolve("scripts/working-tree-fingerprint.mjs");

test("creates a sorted, nonignored cached-and-untracked manifest deterministically", async () => {
  // Given: an isolated Git working tree with tracked, untracked, ignored, and excluded files.
  const root = await createFixture();

  try {
    await writeFile(join(root, "untracked.txt"), "untracked\n");
    await writeFile(join(root, "ignored.txt"), "ignored\n");
    await mkdir(join(root, ".omo", "evidence"), { recursive: true });
    await writeFile(join(root, ".omo", "evidence", "receipt.txt"), "evidence\n");
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "dist", "bundle.js"), "bundle\n");
    await mkdir(join(root, "dist-web"), { recursive: true });
    await writeFile(join(root, "dist-web", "bundle.js"), "bundle\n");
    await mkdir(join(root, "build-test"), { recursive: true });
    await writeFile(join(root, "build-test", "test.js"), "test\n");
    await mkdir(join(root, "evidence"), { recursive: true });
    await writeFile(join(root, "evidence", "receipt.txt"), "evidence\n");

    // When: the fingerprint CLI runs twice against the temporary working tree.
    const first = runFingerprint(root);
    const second = runFingerprint(root);

    // Then: its canonical payload is stable and contains only eligible entries in path order.
    assert.deepEqual(second, first);
    assert.deepEqual(
      first.entries.map((entry) => entry.path),
      [".gitignore", "tracked.txt", "untracked.txt"]
    );
    assert.deepEqual(
      first.entries.map((entry) => entry.status),
      ["tracked", "tracked", "untracked"]
    );
    assert.deepEqual(
      first.entries.map((entry) => entry.type),
      ["file", "file", "file"]
    );
    assert.equal(first.entries[1]?.sha256, sha256("tracked\n"));
    assert.equal(first.entries[2]?.sha256, sha256("untracked\n"));
    assert.equal(first.sha256, sha256(JSON.stringify(first.entries)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("records a cached file that disappears from the working tree as ABSENT", async () => {
  // Given: a tracked file that is removed without changing the Git index.
  const root = await createFixture();

  try {
    await unlink(join(root, "tracked.txt"));

    // When: the fingerprint CLI inspects the cached paths.
    const manifest = runFingerprint(root);

    // Then: the missing path remains observable without a misleading content digest.
    const entry = manifest.entries.find((item) => item.path === "tracked.txt");
    assert.deepEqual(entry, {
      mode: "100644",
      path: "tracked.txt",
      sha256: "ABSENT",
      status: "tracked",
      type: "absent"
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yt2sheet-working-tree-fingerprint-"));
  await runGit(root, ["init", "--quiet"]);
  await runGit(root, ["config", "user.email", "fingerprint@example.test"]);
  await runGit(root, ["config", "user.name", "Fingerprint Test"]);
  await writeFile(join(root, ".gitignore"), "ignored.txt\n");
  await writeFile(join(root, "tracked.txt"), "tracked\n");
  await runGit(root, ["add", ".gitignore", "tracked.txt"]);
  return root;
}

function runGit(root: string, args: readonly string[]): void {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function runFingerprint(root: string): FingerprintManifest {
  const result = spawnSync(process.execPath, [fingerprintScript, "--root", root], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return parseManifest(result.stdout);
}

function parseManifest(raw: string): FingerprintManifest {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) {
    throw new Error("Fingerprint CLI returned an invalid manifest.");
  }
  const { entries, sha256: digest, version } = value;
  if (version !== 1 || typeof digest !== "string" || !Array.isArray(entries)) {
    throw new Error("Fingerprint CLI returned an invalid manifest.");
  }
  return { entries: entries.map(parseEntry), sha256: digest, version };
}

function parseEntry(value: unknown): FingerprintEntry {
  if (
    !isRecord(value) ||
    typeof value.mode !== "string" ||
    typeof value.path !== "string" ||
    typeof value.sha256 !== "string" ||
    (value.status !== "tracked" && value.status !== "untracked") ||
    (value.type !== "absent" && value.type !== "directory" && value.type !== "file" && value.type !== "symlink")
  ) {
    throw new Error("Fingerprint CLI returned an invalid manifest entry.");
  }
  return {
    mode: value.mode,
    path: value.path,
    sha256: value.sha256,
    status: value.status,
    type: value.type
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
