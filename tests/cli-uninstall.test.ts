import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import test from "node:test";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { formatCliUninstallOutcome, uninstallStandaloneCli } from "../cli/uninstall";

test("removes a Unix standalone fixture and only its installer PATH line", async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "yt2sheet-uninstall-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));

  const installRoot = join(fixtureRoot, "install");
  const homeDirectory = join(fixtureRoot, "home");
  const binDirectory = join(homeDirectory, ".local", "bin");
  const profilePath = join(homeDirectory, ".profile");
  const entryPoint = join(installRoot, "app", "dist-cli", "cli", "index.js");
  await mkdir(dirname(entryPoint), { recursive: true });
  await mkdir(join(installRoot, "runtime"));
  await mkdir(join(installRoot, "bin"));
  await mkdir(join(installRoot, "tools"));
  await mkdir(binDirectory, { recursive: true });
  await writeFile(join(installRoot, "VERSION"), "yt2sheet 0.2.0 linux-x64\n", "utf8");
  await writeFile(entryPoint, "", "utf8");
  await writeFile(join(installRoot, "bin", "yt2"), "#!/bin/sh\n", "utf8");
  try {
    await symlink(join(installRoot, "bin", "yt2"), join(binDirectory, "yt2"), "file");
  } catch (error: unknown) {
    if (isSymlinkPermissionError(error)) {
      t.skip("Windows symlink creation requires Developer Mode or SeCreateSymbolicLinkPrivilege.");
      return;
    }
    throw error;
  }
  await writeFile(
    profilePath,
    `export PATH="${binDirectory}:$PATH"\nexport PATH="/keep:$PATH"\n`,
    "utf8"
  );

  const outcome = await uninstallStandaloneCli({
    entryPoint,
    platform: "linux",
    environment: {
      PATH: "",
      YT2SHEET_BIN_DIR: binDirectory,
      YT2SHEET_PROFILE: profilePath
    },
    homeDirectory
  });

  assert.deepEqual(outcome, { kind: "removed", installRoot, deferred: false });
  await assert.rejects(access(installRoot));
  assert.equal(await readFile(profilePath, "utf8"), `export PATH="/keep:$PATH"\n`);
  await assert.rejects(access(join(binDirectory, "yt2")));
});

test("hands non-standalone CLI installs back to npm", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "yt2sheet-npm-"));
  try {
    const outcome = await uninstallStandaloneCli({
      entryPoint: join(fixtureRoot, "package", "dist-cli", "cli", "index.js"),
      platform: "linux",
      environment: {},
      homeDirectory: fixtureRoot
    });

    assert.deepEqual(outcome, { kind: "npm", command: "npm uninstall -g yt2sheet" });
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("removes a Windows standalone fixture immediately", { skip: process.platform !== "win32" }, async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "yt2sheet-windows-uninstall-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));

  const installRoot = join(fixtureRoot, "install");
  await mkdir(join(installRoot, "app"), { recursive: true });
  await mkdir(join(installRoot, "runtime"), { recursive: true });
  await mkdir(join(installRoot, "bin"), { recursive: true });
  await mkdir(join(installRoot, "tools"), { recursive: true });
  await writeFile(join(installRoot, "VERSION"), "yt2sheet 0.2.0 windows-x64\n", "utf8");

  const outcome = await uninstallStandaloneCli({
    entryPoint: join(installRoot, "app", "dist-cli", "cli", "index.js"),
    platform: "win32",
    environment: { ...process.env, YT2SHEET_ROOT: installRoot },
    homeDirectory: fixtureRoot
  });

  assert.deepEqual(outcome, { kind: "removed", installRoot, deferred: false });
  assert.doesNotMatch(formatCliUninstallOutcome(outcome), /scheduled/i);
  await assert.rejects(access(installRoot));
});

function isSymlinkPermissionError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES");
}
