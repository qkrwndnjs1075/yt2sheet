import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const projectRoot = resolve(import.meta.dirname, "..");
const workflowPath = join(projectRoot, ".github/workflows/release-cli.yml");
const inventoryScript = join(projectRoot, "scripts/release/write-inventory.mjs");

test("release workflow schedules the Intel macOS archive on a standard hosted runner", () => {
  // Given: the production release workflow's native build matrix.
  const workflow = readFileSync(workflowPath, "utf8");

  // When: its Intel macOS archive runner is selected.
  const intelRunner = workflow.match(/\{ runner: ([^,]+), target: darwin-x64,/u)?.[1];

  // Then: the job uses the public Intel runner label, not a provisioned larger-runner label.
  assert.equal(intelRunner, "macos-15-intel");
  assert.doesNotMatch(workflow, /macos-15-large/u);
});

test("release inventory records a symlinked native runtime tree", { skip: process.platform === "win32" }, () => {
  // Given: a bundle whose native runtime contains a relative symbolic link.
  const root = mkdtempSync(join(tmpdir(), "yt2sheet-release-inventory-"));
  const bundle = join(root, "bundle");
  const output = join(root, "inventory.json");
  try {
    mkdirSync(join(bundle, "tools/musescore"), { recursive: true });
    writeFileSync(join(bundle, "tools/musescore/runtime.bin"), "runtime\n");
    symlinkSync("runtime.bin", join(bundle, "tools/musescore/runtime-link"));

    // When: the production inventory command scans the bundle.
    const result = spawnSync(process.execPath, [inventoryScript, "--root", bundle, "--output", output], { encoding: "utf8" });

    // Then: it succeeds and preserves both the regular file and the link target.
    assert.equal(result.status, 0, result.stderr);
    const inventory = JSON.parse(readFileSync(output, "utf8"));
    assert.deepEqual(inventory.entries.map(({ path, type, target }) => ({ path, type, target })), [
      { path: "tools/musescore/runtime-link", type: "symlink", target: "runtime.bin" },
      { path: "tools/musescore/runtime.bin", type: "file", target: undefined }
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
