import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import { assertArchiveListingSafe, cacheFileName, stageScoreRuntimes, stagingLimits } from "../scripts/fetch-score-runtimes.mjs";
import { replaceDirectory } from "../scripts/atomic-directory-swap.mjs";
import { stageBundleCompliance } from "../scripts/stage-bundle-compliance.mjs";

const executableNames = {
  audiveris: "Audiveris.app/Contents/MacOS/Audiveris",
  musescore: "MuseScore Studio.app/Contents/MacOS/mscore"
};
const execFileAsync = promisify(execFile);
const fixtureRoots = new Set();
const linuxX64Host = process.platform === "linux" && process.arch === "x64";

async function sha256File(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

after(async () => {
  const roots = [...fixtureRoots];
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  if (process.env.SCORE_RUNTIME_EVIDENCE_DIR) {
    await mkdir(process.env.SCORE_RUNTIME_EVIDENCE_DIR, { recursive: true });
    const remaining = [];
    for (const root of roots) {
      try { await access(root); remaining.push(root); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
    await writeFile(join(process.env.SCORE_RUNTIME_EVIDENCE_DIR, "fixture-root-cleanup.json"), `${JSON.stringify({ roots, remaining }, null, 2)}\n`, "utf8");
  }
});

async function writeExecutable(path, source) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, source, "utf8");
  await chmod(path, 0o755);
}

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "yt2sheet-score-runtime-"));
  fixtureRoots.add(root);
  const cacheRoot = join(root, "cache");
  const fixtureRoot = join(root, "mounted-apps");
  const targetRoot = join(root, "bundle");
  await mkdir(cacheRoot, { recursive: true });
  await mkdir(targetRoot, { recursive: true });
  await writeFile(join(targetRoot, "prior-output"), "keep", "utf8");
  await cp(resolve(import.meta.dirname, "fixtures/score-runtimes/darwin"), fixtureRoot, { recursive: true });
  await chmod(join(fixtureRoot, "audiveris", executableNames.audiveris), 0o755);
  await chmod(join(fixtureRoot, "musescore", executableNames.musescore), 0o755);

  const runtimes = {};
  for (const [tool, appPath] of Object.entries(executableNames)) {
    const assetName = `${tool}.dmg`;
    const archive = Buffer.from(`fixture archive for ${tool}`);
    const sha256 = createHash("sha256").update(archive).digest("hex");
    runtimes[tool] = {
      assetName,
      url: `https://fixtures.invalid/${assetName}`,
      sha256,
      extraction: "dmg-copy-app",
      stagedExecutable: `tools/${tool}/${appPath}`,
      versionProbe: { args: ["--version"], expected: tool === "audiveris" ? "5.11.0" : "4.7.4" }
    };
    await writeFile(join(cacheRoot, cacheFileName(runtimes[tool])), archive);
    const executable = join(fixtureRoot, tool, appPath);
    if (options.missingExecutable !== tool) {
      if (options.lostExecutableBit === tool) await chmod(executable, 0o644);
      if (options.traversal === tool) await symlink("/tmp", join(executable, "..", "escape"));
      if (options.transientTraversal === tool) await symlink("../../../../../.extract-audiveris/payload", join(executable, "..", "transient"));
    } else await rm(executable);
  }

  const manifest = {
    schemaVersion: "score-runtime-manifest/1",
    tools: {
      audiveris: { version: "5.11.0" },
      musescore: { version: "4.7.4" }
    },
    platforms: [{ id: "macos-14-arm64", releaseTarget: "darwin-arm64", os: "macos", osVersion: "14", arch: "arm64", runtimes }]
  };
  const manifestPath = join(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

  const fakeHdiutil = join(root, "hdiutil");
  await writeExecutable(fakeHdiutil, `#!/bin/sh
set -eu
if [ "\${1}" = "detach" ]; then exit 0; fi
if [ "\${LONG_EXTRACTION:-0}" = "1" ]; then sleep 30; fi
if [ "\${REQUIRE_LICENSE:-0}" = "1" ]; then
  IFS= read -r acceptance || exit 112
  [ "$acceptance" = "y" ] || exit 112
fi
mountpoint="\${5}"
archive="\${6}"
case "$archive" in
  *audiveris*) cp -R "$FIXTURE_ROOT/audiveris/Audiveris.app" "$mountpoint/" ;;
  *) cp -R "$FIXTURE_ROOT/musescore/MuseScore Studio.app" "$mountpoint/" ;;
esac
`);
  const fakeDitto = join(root, "ditto");
  await writeExecutable(fakeDitto, `#!/bin/sh
set -eu
cp -R "$1" "$2"
`);
  const fakeCodesign = join(root, "codesign");
  const fakeSpctl = join(root, "spctl");
  const signatureCommand = `#!/bin/sh
echo 'accepted and valid'
if [ "\${ADHOC_SIGNATURE:-0}" = "1" ] && [ "$(basename "$0")" = "codesign" ]; then echo 'Signature=adhoc' >&2; fi
if [ "\${SPCTL_FAIL:-0}" = "1" ] && [ "$(basename "$0")" = "spctl" ]; then exit 3; fi
if [ "\${SIGNATURE_FAIL:-0}" = "1" ]; then exit 1; fi
`;
  await writeExecutable(fakeCodesign, signatureCommand);
  await writeExecutable(fakeSpctl, signatureCommand);

  return {
    root, cacheRoot, fixtureRoot, targetRoot, manifestPath,
    commands: { hdiutil: fakeHdiutil, ditto: fakeDitto, codesign: fakeCodesign, spctl: fakeSpctl }
  };
}

async function portableFixture(platformId) {
  const root = await mkdtemp(join(tmpdir(), "yt2sheet-score-runtime-portable-"));
  fixtureRoots.add(root);
  const cacheRoot = join(root, "cache");
  const sourceRoot = join(root, "sources");
  const targetRoot = join(root, "bundle");
  await mkdir(cacheRoot, { recursive: true });
  const isWindows = platformId === "windows-2022-x64";
  const platform = isWindows
    ? { id: platformId, releaseTarget: "windows-x64", os: "windows", osVersion: "2022", arch: "x64" }
    : { id: platformId, releaseTarget: "linux-x64", os: "ubuntu", osVersion: "22.04", arch: "x64" };
  const runtimes = {};
  for (const tool of Object.keys(executableNames)) {
    const executableName = isWindows ? (tool === "audiveris" ? "Audiveris.exe" : "MuseScore4.exe") : (tool === "audiveris" ? "Audiveris" : "AppRun");
    const extraction = isWindows ? "msi-admin" : (tool === "audiveris" ? "deb-extract" : "appimage-extract");
    const assetName = `${tool}.${isWindows ? "msi" : (tool === "audiveris" ? "deb" : "AppImage")}`;
    const stagedExecutable = `tools/${tool}/${tool === "audiveris" || isWindows ? "bin/" : ""}${executableName}`;
    const sourceExecutable = join(sourceRoot, tool, tool === "audiveris" || isWindows ? "bin" : "", executableName);
    await writeExecutable(sourceExecutable, `#!/bin/sh\necho '${tool === "audiveris" ? "5.11.0" : "4.7.4"}'\n`);
    let archive = Buffer.from(`fixture archive for ${platformId}/${tool}`);
    if (extraction === "appimage-extract") {
      archive = Buffer.from(`#!/bin/sh\nset -eu\nmkdir -p squashfs-root\ncp -R "$FIXTURE_ROOT/musescore/." squashfs-root/\n`);
    }
    const sha256 = createHash("sha256").update(archive).digest("hex");
    runtimes[tool] = { assetName, url: `https://fixtures.invalid/${assetName}`, sha256, extraction, stagedExecutable, versionProbe: { args: ["--version"], expected: tool === "audiveris" ? "5.11.0" : "4.7.4" } };
    await writeFile(join(cacheRoot, cacheFileName(runtimes[tool])), archive);
  }
  platform.runtimes = runtimes;
  const manifestPath = join(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify({
    schemaVersion: "score-runtime-manifest/1",
    tools: { audiveris: { version: "5.11.0" }, musescore: { version: "4.7.4" } },
    platforms: [platform]
  }), "utf8");
  const extractor = join(root, isWindows ? "msiexec" : "dpkg-deb");
  await writeExecutable(extractor, isWindows ? `#!/bin/sh
set -eu
target="\${4#TARGETDIR=}"
if [ "\${OVERSIZE:-0}" = "1" ]; then
  mkdir -p "$target"
  node -e 'const fs=require("fs"); fs.writeFileSync(process.argv[1], ""); fs.truncateSync(process.argv[1], 2147483649)' "$target/oversize"
  while :; do :; done
fi
case "\${2}" in *audiveris*) tool=audiveris ;; *) tool=musescore ;; esac
mkdir -p "$target/$tool"
cp -R "$FIXTURE_ROOT/$tool/." "$target/$tool/"
` : `#!/bin/sh
set -eu
if [ "\${1}" = "--contents" ]; then echo '-rwxr-xr-x root/root 1 2026-01-01 00:00 ./opt/audiveris/bin/Audiveris'; exit 0; fi
mkdir -p "\${3}/opt/audiveris"
cp -R "$FIXTURE_ROOT/audiveris/." "\${3}/opt/audiveris/"
`);
  return {
    root, cacheRoot, sourceRoot, targetRoot, manifestPath, platformId,
    commands: isWindows ? { msiexec: extractor } : { dpkgDeb: extractor }
  };
}

async function stage(local, overrides = {}) {
  return stageScoreRuntimes({
    manifestPath: local.manifestPath,
    platformId: "macos-14-arm64",
    targetRoot: local.targetRoot,
    cacheRoot: local.cacheRoot,
    offline: true,
    commands: local.commands,
    environment: { FIXTURE_ROOT: local.fixtureRoot },
    ...overrides
  });
}

async function buildBundleFixture(target = "darwin-arm64") {
  const local = target === "linux-x64" ? await portableFixture("ubuntu-22.04-x64") : await fixture();
  const generatorPath = join(local.root, "compliance-generator.mjs");
  const ytDlpPath = join(local.root, "yt-dlp");
  const runtimeNodePath = join(local.root, "fixture-runtime-node");
  const fixtureConfigPath = join(local.root, "build-fixture.json");
  await writeExecutable(ytDlpPath, "#!/bin/sh\necho 'fixture yt-dlp'\n");
  await writeExecutable(runtimeNodePath, "#!/bin/sh\necho 'fixture runtime node'\n");
  await writeFile(generatorPath, `import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const output = process.argv[process.argv.indexOf("--output") + 1];
await mkdir(join(output, "THIRD_PARTY", "fixture"), { recursive: true });
await writeFile(join(output, "THIRD_PARTY", "fixture", "NOTICE"), "fixture compliance\\n");
for (const name of ["COMPLIANCE_SUMMARY.json", "SOURCE_MANIFEST.json", "bom.cdx.json"]) await writeFile(join(output, name), "{}\\n");
await writeFile(join(output, "THIRD_PARTY_NOTICES.md"), "# Fixture notices\\n");
`, "utf8");
  await writeFile(fixtureConfigPath, JSON.stringify({
    target,
    runtimeCommands: local.commands,
    runtimeEnvironment: { FIXTURE_ROOT: local.fixtureRoot ?? local.sourceRoot },
    complianceGeneratorPath: generatorPath,
    ytDlpPath,
    runtimeNodePath
  }), "utf8");
  return { ...local, outputRoot: join(local.root, "output"), fixtureConfigPath, runtimeNodePath, target };
}

async function invokeBuildBundle(local, target = local.target, fixtureConfigPath = local.fixtureConfigPath) {
  const args = [
    "scripts/build-bundle.mjs", "--output", local.outputRoot,
    "--runtime-manifest", local.manifestPath, "--runtime-cache", local.cacheRoot, "--runtime-offline"
  ];
  if (target) args.push("--target", target);
  return execFileAsync(process.execPath, args, {
    cwd: resolve(import.meta.dirname, ".."),
    env: { ...process.env, NODE_ENV: "test", YT2SHEET_TEST_BUNDLE_FIXTURE_CONFIG: fixtureConfigPath },
    maxBuffer: 4 * 1024 * 1024
  });
}

async function assertNoBundleScratch(root) {
  assert.deepEqual(await bundleScratch(root), []);
}

async function bundleScratch(root) {
  return (await readdir(root)).filter((name) => /^\.(?:bundle-|score-runtime|compliance-)/.test(name));
}

async function assertPriorOutputIsUntouched(local) {
  assert.equal(await readFile(join(local.targetRoot, "prior-output"), "utf8"), "keep");
  await assert.rejects(access(join(local.targetRoot, "tools", "audiveris")));
  const leftovers = (await readdir(local.root)).filter((name) => name.includes("score-runtime-stage"));
  assert.deepEqual(leftovers, []);
}

test("exports the fixed staging budgets", () => {
  // Given/When: the public staging budgets are inspected.
  // Then: they match the release security contract.
  assert.deepEqual(stagingLimits, {
    archiveBytes: 750 * 1024 * 1024,
    installedBytes: 2 * 1024 * 1024 * 1024,
    temporaryBytes: 4 * 1024 * 1024 * 1024
  });
});

test("restores a prior bundle when the final staged-directory swap fails", async () => {
  // Given: an existing bundle and a staged path that vanished before the final rename.
  const root = await mkdtemp(join(tmpdir(), "yt2sheet-bundle-swap-"));
  const output = join(root, "output");
  await mkdir(output);
  await writeFile(join(output, "prior-output"), "keep", "utf8");
  // When: the post-staging atomic swap fails.
  await assert.rejects(replaceDirectory(join(root, "missing-stage"), output), /ENOENT/);
  // Then: rollback restores the exact prior output.
  assert.equal(await readFile(join(output, "prior-output"), "utf8"), "keep");
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith(".bundle-backup-")), []);
});

test("does not merge partial compliance output when generation fails", async () => {
  // Given: a staged bundle and a generator that writes partial sibling output then fails.
  const root = await mkdtemp(join(tmpdir(), "yt2sheet-compliance-stage-"));
  const bundleRoot = join(root, "bundle");
  const generatorPath = join(root, "generator.mjs");
  await mkdir(bundleRoot);
  await writeFile(join(bundleRoot, "prior-output"), "keep", "utf8");
  await writeFile(generatorPath, `import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const output = process.argv[process.argv.indexOf("--output") + 1];
await mkdir(output, { recursive: true });
await writeFile(join(output, "partial"), "partial");
process.exit(7);
`, "utf8");
  // When: compliance generation exits nonzero before the bundle swap.
  await assert.rejects(stageBundleCompliance({
    generatorPath, runtimeManifestPath: "manifest", packageLockPath: "lock",
    platformId: "macos-14-arm64", bundleRoot
  }));
  // Then: no partial artifact is merged and all compliance scratch is removed.
  assert.equal(await readFile(join(bundleRoot, "prior-output"), "utf8"), "keep");
  await assert.rejects(access(join(bundleRoot, "partial")));
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith(".compliance-build-")), []);
});

test("merges only a complete compliance root into the staged bundle", async () => {
  // Given: a generator that emits every required compliance root artifact.
  const root = await mkdtemp(join(tmpdir(), "yt2sheet-compliance-complete-"));
  const bundleRoot = join(root, "bundle");
  const generatorPath = join(root, "generator.mjs");
  await mkdir(bundleRoot);
  await writeFile(generatorPath, `import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const output = process.argv[process.argv.indexOf("--output") + 1];
await mkdir(join(output, "THIRD_PARTY"), { recursive: true });
for (const name of ["COMPLIANCE_SUMMARY.json", "SOURCE_MANIFEST.json", "THIRD_PARTY_NOTICES.md", "bom.cdx.json"]) await writeFile(join(output, name), name);
`, "utf8");
  // When: production-shaped compliance output is staged.
  await stageBundleCompliance({
    generatorPath, runtimeManifestPath: "manifest", packageLockPath: "lock",
    platformId: "macos-14-arm64", bundleRoot
  });
  // Then: root metadata and THIRD_PARTY are merged, with no sibling scratch left.
  await access(join(bundleRoot, "COMPLIANCE_SUMMARY.json"));
  await access(join(bundleRoot, "THIRD_PARTY"));
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith(".compliance-build-")), []);
});

test("rejects a malicious archive listing before extraction", () => {
  // Given: a dpkg archive listing containing a parent-directory entry.
  const listing = "-rw-r--r-- root/root 1 2026-01-01 00:00 ./../../escape payload";
  // When/Then: the pre-extraction traversal check fails closed.
  assert.throws(() => assertArchiveListingSafe(listing), /traversal/i);
});

test("stages cached signed macOS apps and writes a deterministic inventory", async () => {
  // Given: pinned local cache assets and deterministic signed-app command fixtures.
  const local = await fixture();
  // When: the matching manifest platform is staged.
  const result = await stage(local);
  // Then: both executable probes and the hashed permissions inventory are observable.
  assert.deepEqual(result.versionProbes, { audiveris: "5.11.0", musescore: "4.7.4" });
  const inventoryPath = join(local.targetRoot, "tools", "score-runtime-inventory.json");
  const firstInventory = await readFile(inventoryPath, "utf8");
  await stage(local);
  assert.equal(await readFile(inventoryPath, "utf8"), firstInventory);
  const inventory = JSON.parse(firstInventory);
  assert.equal(inventory.platformId, "macos-14-arm64");
  assert.equal(await readFile(join(local.targetRoot, "prior-output"), "utf8"), "keep");
  assert.equal(inventory.entries.filter((entry) => entry.type === "file").length, 2);
  assert.ok(inventory.entries.every((entry) => entry.mode && (entry.type !== "file" || entry.sha256)));
  if (process.env.SCORE_RUNTIME_EVIDENCE_DIR) {
    await mkdir(process.env.SCORE_RUNTIME_EVIDENCE_DIR, { recursive: true });
    await writeFile(join(process.env.SCORE_RUNTIME_EVIDENCE_DIR, "fixture-runtime-inventory.json"), firstInventory, "utf8");
    await writeFile(join(process.env.SCORE_RUNTIME_EVIDENCE_DIR, "fixture-version-probes.json"), `${JSON.stringify(result.versionProbes, null, 2)}\n`, "utf8");
  }
});

test("accepts a noninteractive macOS disk-image license before copying the app", async () => {
  // Given: a DMG extractor that models hdiutil's embedded-license prompt.
  const local = await fixture();
  // When: staging supplies the explicit acceptance through the extractor seam.
  const result = await stage(local, { environment: { FIXTURE_ROOT: local.fixtureRoot, REQUIRE_LICENSE: "1" } });
  // Then: both apps are staged and version probes remain observable.
  assert.deepEqual(result.versionProbes, { audiveris: "5.11.0", musescore: "4.7.4" });
  await access(join(local.targetRoot, "tools", "audiveris", executableNames.audiveris));
  await access(join(local.targetRoot, "tools", "musescore", executableNames.musescore));
});

test("accepts pinned runtime versions inside official tool banners", async () => {
  // Given: the official macOS probes emit a banner instead of a bare version.
  const local = await fixture();
  await writeExecutable(join(local.fixtureRoot, "audiveris", executableNames.audiveris), "#!/bin/sh\nprintf 'Audiveris\\n- Version:      5.11.0\\n'\n");
  await writeExecutable(join(local.fixtureRoot, "musescore", executableNames.musescore), "#!/bin/sh\nprintf 'MuseScore4 4.7.4\\n'\n");
  // When: the pinned runtimes are staged and probed through their real command boundary.
  const result = await stage(local);
  // Then: the semantic versions are accepted without weakening exact-channel checks.
  assert.deepEqual(result.versionProbes, { audiveris: "5.11.0", musescore: "4.7.4" });
});

test("rejects non-exact version probe output and preserves the prior bundle", async () => {
  // Given: pinned root versions and probes, but success-exit executables emit misleading output.
  const scenarios = [
    { label: "forged suffix", stdout: "5.11.0 4.7.4 forged", stderr: "" },
    { label: "wrong substring", stdout: "not-5.11.0-but-wrong", stderr: "" },
    { label: "conflicting stderr", stdout: "5.11.0", stderr: "forged" }
  ];
  const observations = [];
  for (const scenario of scenarios) {
    const local = await fixture();
    await writeExecutable(join(local.fixtureRoot, "audiveris", executableNames.audiveris), `#!/bin/sh
printf '%s' ${JSON.stringify(scenario.stdout)}
printf '%s' ${JSON.stringify(scenario.stderr)} >&2
`);
    // When/Then: a non-exact observation is rejected before publication.
    const failure = await stage(local).then(() => undefined, (error) => error);
    assert.ok(failure, scenario.label);
    assert.match(String(failure), /version probe mismatch/i, scenario.label);
    await assertPriorOutputIsUntouched(local);
    const scratch = (await readdir(local.root)).filter((name) => /^\.(?:bundle-|score-runtime|compliance-)/.test(name));
    assert.deepEqual(scratch, [], scenario.label);
    observations.push({ ...scenario, exitCode: 1, error: String(failure), priorOutput: await readFile(join(local.targetRoot, "prior-output"), "utf8"), scratch });
  }
  if (process.env.SCORE_RUNTIME_EVIDENCE_DIR) {
    await mkdir(process.env.SCORE_RUNTIME_EVIDENCE_DIR, { recursive: true });
    await writeFile(join(process.env.SCORE_RUNTIME_EVIDENCE_DIR, "forged-output-receipt.json"), `${JSON.stringify({ scenarios: observations }, null, 2)}\n`, "utf8");
  }
});

test("rejects forged authoritative tool versions even when executable probes match", async () => {
  // Given: root tool versions and runtime probes forged to the same unsupported value.
  const local = await fixture();
  const manifest = JSON.parse(await readFile(local.manifestPath, "utf8"));
  manifest.tools.audiveris.version = "9.9.9";
  manifest.tools.musescore.version = "9.9.9";
  for (const runtime of Object.values(manifest.platforms[0].runtimes)) runtime.versionProbe.expected = "9.9.9";
  await writeFile(local.manifestPath, JSON.stringify(manifest), "utf8");
  for (const [tool, executableName] of Object.entries(executableNames)) {
    await writeExecutable(join(local.fixtureRoot, tool, executableName), "#!/bin/sh\necho '9.9.9'\n");
  }
  // When/Then: manifest parsing rejects before trusting matching executable output.
  await assert.rejects(stage(local), /version|pinned/i);
  await assertPriorOutputIsUntouched(local);
});

test("rejects malformed authoritative versions before extraction", async () => {
  // Given: a non-string root version and a command that must never be reached.
  const local = await fixture();
  const manifest = JSON.parse(await readFile(local.manifestPath, "utf8"));
  manifest.tools.audiveris.version = null;
  await writeFile(local.manifestPath, JSON.stringify(manifest), "utf8");
  // When/Then: manifest parsing fails closed before invoking extraction.
  await assert.rejects(stage(local, { commands: { ...local.commands, hdiutil: join(local.root, "must-not-run") } }), /authoritative version/i);
  await assertPriorOutputIsUntouched(local);
});

test("rejects a probe expectation that differs from the authoritative version", async () => {
  // Given: pinned root versions but a forged platform probe expectation.
  const local = await fixture();
  const manifest = JSON.parse(await readFile(local.manifestPath, "utf8"));
  manifest.platforms[0].runtimes.musescore.versionProbe.expected = "9.9.9";
  await writeFile(local.manifestPath, JSON.stringify(manifest), "utf8");
  // When/Then: manifest parsing rejects before any executable output is trusted.
  await assert.rejects(stage(local, { commands: { ...local.commands, hdiutil: join(local.root, "must-not-run") } }), /invalid runtime manifest entry/i);
  await assertPriorOutputIsUntouched(local);
});

test("publishes a complete bundle through the real build-bundle entrypoint", async (context) => {
  // Given: tiny offline runtime archives and explicitly gated local command/compliance fixtures.
  const local = await buildBundleFixture();
  context.after(() => rm(local.root, { recursive: true, force: true }));
  // When: the real build-bundle CLI entrypoint runs for the host target.
  const result = await invokeBuildBundle(local);
  // Then: the atomically published tree is complete, executable, and byte-verifiable.
  assert.match(result.stdout, /번들 생성 완료/);
  const required = [
    "tools/audiveris", "tools/musescore", "tools/score-runtime-inventory.json", "THIRD_PARTY",
    "THIRD_PARTY_NOTICES.md", "bom.cdx.json", "SOURCE_MANIFEST.json", "COMPLIANCE_SUMMARY.json",
    "app/dist-cli/cli/index.js", "scripts/score-runtime-manifest.json", "runtime/bin/node", "VERSION"
  ];
  for (const path of required) {
    const item = await lstat(join(local.outputRoot, path));
    assert.ok(item.isFile() ? item.size > 0 : (await readdir(join(local.outputRoot, path))).length > 0, path);
  }
  assert.ok((await readdir(join(local.outputRoot, "THIRD_PARTY"))).length > 0);
  assert.match(await readFile(join(local.outputRoot, "VERSION"), "utf8"), /darwin-arm64/);
  const manifest = JSON.parse(await readFile(local.manifestPath, "utf8"));
  assert.deepEqual(JSON.parse(await readFile(join(local.outputRoot, "scripts/score-runtime-manifest.json"))), manifest);
  const inventorySource = await readFile(join(local.outputRoot, "tools/score-runtime-inventory.json"), "utf8");
  const inventory = JSON.parse(inventorySource);
  let verifiedInventoryEntries = 0;
  for (const tool of Object.keys(executableNames)) {
    const runtime = manifest.platforms[0].runtimes[tool];
    const probe = await execFileAsync(join(local.outputRoot, runtime.stagedExecutable), runtime.versionProbe.args);
    assert.match(`${probe.stdout}\n${probe.stderr}`, new RegExp(runtime.versionProbe.expected.replaceAll(".", "\\.")));
  }
  for (const entry of inventory.entries) {
    const path = join(local.outputRoot, entry.path);
    const item = await lstat(path);
    assert.equal((item.mode & 0o7777).toString(8).padStart(4, "0"), entry.mode);
    if (entry.type === "file") assert.equal(createHash("sha256").update(await readFile(path)).digest("hex"), entry.sha256);
    verifiedInventoryEntries += 1;
  }
  await assertNoBundleScratch(local.root);
  if (process.env.SCORE_RUNTIME_EVIDENCE_DIR) {
    await writeFile(join(process.env.SCORE_RUNTIME_EVIDENCE_DIR, "successful-build-inventory.json"), inventorySource, "utf8");
    await writeFile(join(process.env.SCORE_RUNTIME_EVIDENCE_DIR, "successful-build-entrypoint.json"), `${JSON.stringify({ invocation: process.execPath + " scripts/build-bundle.mjs --output <tmp>/output --runtime-manifest <fixture>/manifest.json --runtime-cache <fixture>/cache --runtime-offline", exitCode: 0, stdout: result.stdout, required }, null, 2)}\n`, "utf8");
    await writeFile(join(process.env.SCORE_RUNTIME_EVIDENCE_DIR, "successful-bundle-required-tree.txt"), `${required.join("\n")}\n`, "utf8");
    await writeFile(join(process.env.SCORE_RUNTIME_EVIDENCE_DIR, "inventory-recomputation.json"), `${JSON.stringify({ verifiedInventoryEntries, mismatches: 0 }, null, 2)}\n`, "utf8");
    await writeFile(join(process.env.SCORE_RUNTIME_EVIDENCE_DIR, "successful-build-cleanup.json"), `${JSON.stringify({ stagingLeftovers: await bundleScratch(local.root) }, null, 2)}\n`, "utf8");
  }
});

test("publishes a Linux bundle from darwin only with an explicit Linux fixture target and runtime node", async (context) => {
  // Given: tiny cached Linux archives, native extraction stand-ins, and a distinct Linux runtime-node fixture.
  const local = await buildBundleFixture("linux-x64");
  context.after(() => rm(local.root, { recursive: true, force: true }));
  // When: the real build CLI is explicitly asked to stage the Linux release target from this darwin host.
  const result = await invokeBuildBundle(local, "linux-x64");
  // Then: publication uses the declared fixture runtime node rather than the host executable.
  assert.match(result.stdout, /번들 생성 완료/);
  const required = [
    "tools/audiveris", "tools/musescore", "tools/score-runtime-inventory.json", "THIRD_PARTY",
    "THIRD_PARTY_NOTICES.md", "bom.cdx.json", "SOURCE_MANIFEST.json", "COMPLIANCE_SUMMARY.json",
    "app/dist-cli/cli/index.js", "scripts/score-runtime-manifest.json", "runtime/bin/node", "VERSION"
  ];
  for (const path of required) await access(join(local.outputRoot, path));
  assert.match(await readFile(join(local.outputRoot, "VERSION"), "utf8"), /linux-x64/);
  assert.deepEqual(JSON.parse(await readFile(join(local.outputRoot, "scripts/score-runtime-manifest.json"))), JSON.parse(await readFile(local.manifestPath, "utf8")));
  const bundledRuntimeNode = join(local.outputRoot, "runtime", "bin", "node");
  const expectedRuntimeNode = process.platform === "linux" && process.arch === "x64" ? process.execPath : local.runtimeNodePath;
  assert.equal(await sha256File(bundledRuntimeNode), await sha256File(expectedRuntimeNode));
  const manifest = JSON.parse(await readFile(local.manifestPath, "utf8"));
  for (const [tool, runtime] of Object.entries(manifest.platforms[0].runtimes)) {
    const probe = await execFileAsync(join(local.outputRoot, runtime.stagedExecutable), runtime.versionProbe.args);
    assert.equal(probe.stdout.trim(), runtime.versionProbe.expected, tool);
    assert.equal(probe.stderr, "", tool);
  }
  const inventory = JSON.parse(await readFile(join(local.outputRoot, "tools", "score-runtime-inventory.json"), "utf8"));
  for (const entry of inventory.entries) {
    const item = await lstat(join(local.outputRoot, entry.path));
    assert.equal((item.mode & 0o7777).toString(8).padStart(4, "0"), entry.mode, entry.path);
    if (entry.type === "file") assert.equal(createHash("sha256").update(await readFile(join(local.outputRoot, entry.path))).digest("hex"), entry.sha256, entry.path);
  }
  await assertNoBundleScratch(local.root);
  if (process.env.SCORE_RUNTIME_EVIDENCE_DIR) {
    await mkdir(process.env.SCORE_RUNTIME_EVIDENCE_DIR, { recursive: true });
    const runtimeNode = await readFile(join(local.outputRoot, "runtime", "bin", "node"));
    await writeFile(join(process.env.SCORE_RUNTIME_EVIDENCE_DIR, "linux-crosshost-manual-pass.json"), `${JSON.stringify({
      command: `NODE_ENV=test YT2SHEET_TEST_BUNDLE_FIXTURE_CONFIG=${local.fixtureConfigPath} ${process.execPath} scripts/build-bundle.mjs --output ${local.outputRoot} --target linux-x64 --runtime-manifest ${local.manifestPath} --runtime-cache ${local.cacheRoot} --runtime-offline`,
      environment: { NODE_ENV: "test", YT2SHEET_TEST_BUNDLE_FIXTURE_CONFIG: local.fixtureConfigPath },
      exitCode: 0, stdout: result.stdout, stderr: result.stderr, required,
      runtimeNodeSha256: createHash("sha256").update(runtimeNode).digest("hex"),
      fixtureRuntimeNodeSha256: createHash("sha256").update(await readFile(local.runtimeNodePath)).digest("hex"),
      versionProbes: inventory.versionProbes, stagingLeftovers: await bundleScratch(local.root)
    }, null, 2)}\n`, "utf8");
    await writeFile(join(process.env.SCORE_RUNTIME_EVIDENCE_DIR, "linux-crosshost-inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
  }
});

test("rejects a malformed runtime manifest before bundle swap and preserves the prior output", async (context) => {
  // Given: an existing published marker and a malformed manifest selected for the next bundle.
  const local = await buildBundleFixture();
  context.after(() => rm(local.root, { recursive: true, force: true }));
  await mkdir(local.outputRoot, { recursive: true });
  await writeFile(join(local.outputRoot, "prior-output"), "keep", "utf8");
  await writeFile(local.manifestPath, "{\n", "utf8");

  // When/Then: staging fails before publication and the prior bytes plus no scratch roots remain.
  const failure = await invokeBuildBundle(local).then(() => undefined, (error) => error);
  assert.match(String(failure), /JSON|manifest|Unexpected/i);
  assert.equal(await readFile(join(local.outputRoot, "prior-output"), "utf8"), "keep");
  assert.deepEqual((await readdir(local.outputRoot)).sort(), ["prior-output"]);
  await assertNoBundleScratch(local.root);
});

test("rejects every incomplete Linux cross-host fixture before publication", { skip: linuxX64Host ? "Linux x64 is the same-host target; cross-host guard is not applicable" : false }, async (context) => {
  // Given: Linux-target fixture configurations missing one required cross-host binding.
  const local = await buildBundleFixture("linux-x64");
  context.after(() => rm(local.root, { recursive: true, force: true }));
  const baseline = JSON.parse(await readFile(local.fixtureConfigPath, "utf8"));
  const scenarios = [
    ["missing target", (fixture) => { delete fixture.target; }],
    ["mismatched target", (fixture) => { fixture.target = "darwin-arm64"; }],
    ["missing runtime node", (fixture) => { delete fixture.runtimeNodePath; }]
  ];
  const observations = [];
  for (const [label, mutate] of scenarios) {
    const fixture = structuredClone(baseline);
    mutate(fixture);
    const fixturePath = join(local.root, `${label.replaceAll(" ", "-")}.json`);
    await writeFile(fixturePath, JSON.stringify(fixture), "utf8");
    // When/Then: cross-host publication remains closed and leaves no output or scratch state.
    const failure = await invokeBuildBundle(local, "linux-x64", fixturePath).then(() => undefined, (error) => error);
    assert.match(String(failure), /fixture|실행 환경/);
    await assert.rejects(access(local.outputRoot));
    await assertNoBundleScratch(local.root);
    observations.push({ label, exitCode: failure?.code, error: String(failure), stagingLeftovers: await bundleScratch(local.root) });
  }
  if (process.env.SCORE_RUNTIME_EVIDENCE_DIR) {
    await mkdir(process.env.SCORE_RUNTIME_EVIDENCE_DIR, { recursive: true });
    await writeFile(join(process.env.SCORE_RUNTIME_EVIDENCE_DIR, "linux-crosshost-incomplete-fixtures.json"), `${JSON.stringify(observations, null, 2)}\n`, "utf8");
  }
});

test("rejects a Linux cross-host target without the fixture environment", { skip: linuxX64Host ? "Linux x64 is the same-host target; cross-host guard is not applicable" : false }, async (context) => {
  // Given: a custom fixture manifest and cache but no narrowly named fixture environment.
  const local = await buildBundleFixture("linux-x64");
  context.after(() => rm(local.root, { recursive: true, force: true }));
  // When/Then: the production host guard rejects before publication.
  const failure = await execFileAsync(process.execPath, [
    "scripts/build-bundle.mjs", "--output", local.outputRoot, "--target", "linux-x64",
    "--runtime-manifest", local.manifestPath, "--runtime-cache", local.cacheRoot, "--runtime-offline"
  ], { cwd: resolve(import.meta.dirname, ".."), env: { ...process.env, NODE_ENV: "test" } }).then(() => undefined, (error) => error);
  assert.match(String(failure), /현재 실행 환경/);
  await assert.rejects(access(local.outputRoot));
  await assertNoBundleScratch(local.root);
  if (process.env.SCORE_RUNTIME_EVIDENCE_DIR) {
    await mkdir(process.env.SCORE_RUNTIME_EVIDENCE_DIR, { recursive: true });
    await writeFile(join(process.env.SCORE_RUNTIME_EVIDENCE_DIR, "linux-crosshost-no-fixture-guard.json"), `${JSON.stringify({ exitCode: failure?.code, error: String(failure), stagingLeftovers: await bundleScratch(local.root) }, null, 2)}\n`, "utf8");
  }
});

test("keeps a Linux prior marker when cross-host cache verification fails", async (context) => {
  // Given: an explicit Linux fixture, corrupt offline cache, and a prior published marker.
  const local = await buildBundleFixture("linux-x64");
  context.after(() => rm(local.root, { recursive: true, force: true }));
  await mkdir(local.outputRoot);
  await writeFile(join(local.outputRoot, "prior-output"), "keep", "utf8");
  const markerSha256 = createHash("sha256").update(await readFile(join(local.outputRoot, "prior-output"))).digest("hex");
  const manifest = JSON.parse(await readFile(local.manifestPath, "utf8"));
  await writeFile(join(local.cacheRoot, cacheFileName(manifest.platforms[0].runtimes.audiveris)), "corrupt", "utf8");
  // When/Then: the same real cross-host CLI fails without swapping the marker.
  const failure = await invokeBuildBundle(local, "linux-x64").then(() => undefined, (error) => error);
  assert.match(String(failure), /SHA-256/);
  assert.equal(createHash("sha256").update(await readFile(join(local.outputRoot, "prior-output"))).digest("hex"), markerSha256);
  assert.deepEqual(await readdir(local.outputRoot), ["prior-output"]);
  await assertNoBundleScratch(local.root);
  if (process.env.SCORE_RUNTIME_EVIDENCE_DIR) {
    await mkdir(process.env.SCORE_RUNTIME_EVIDENCE_DIR, { recursive: true });
    await writeFile(join(process.env.SCORE_RUNTIME_EVIDENCE_DIR, "linux-crosshost-corrupt-cache-rollback.json"), `${JSON.stringify({ exitCode: failure?.code, error: String(failure), markerSha256, markerSha256After: createHash("sha256").update(await readFile(join(local.outputRoot, "prior-output"))).digest("hex"), stagingLeftovers: await bundleScratch(local.root) }, null, 2)}\n`, "utf8");
  }
});

test("keeps old output when the real build-bundle entrypoint rejects corrupt cache", async (context) => {
  // Given: corrupt offline cache and a preexisting published output marker.
  const local = await buildBundleFixture();
  context.after(() => rm(local.root, { recursive: true, force: true }));
  await mkdir(local.outputRoot);
  await writeFile(join(local.outputRoot, "prior-output"), "keep", "utf8");
  const manifest = JSON.parse(await readFile(local.manifestPath, "utf8"));
  await writeFile(join(local.cacheRoot, cacheFileName(manifest.platforms[0].runtimes.audiveris)), "corrupt", "utf8");
  // When: the same real entrypoint fails before publication.
  let failure;
  try { await invokeBuildBundle(local); } catch (error) { failure = error; }
  assert.match(String(failure), /SHA-256/);
  assert.equal(failure?.code, 1);
  // Then: the old marker remains and all nested staging roots are gone.
  assert.equal(await readFile(join(local.outputRoot, "prior-output"), "utf8"), "keep");
  assert.deepEqual(await readdir(local.outputRoot), ["prior-output"]);
  await assertNoBundleScratch(local.root);
  if (process.env.SCORE_RUNTIME_EVIDENCE_DIR) {
    await writeFile(join(process.env.SCORE_RUNTIME_EVIDENCE_DIR, "failure-rollback.json"), `${JSON.stringify({ exitCode: failure.code, priorMarker: "keep", outputEntries: await readdir(local.outputRoot), stagingLeftovers: await bundleScratch(local.root) }, null, 2)}\n`, "utf8");
  }
});

test("does not enable local build overrides for the production manifest", async (context) => {
  // Given: the narrowly named fixture environment is present but the production manifest is selected.
  const local = await buildBundleFixture();
  context.after(() => rm(local.root, { recursive: true, force: true }));
  // When/Then: the CLI rejects the override before staging or publication.
  const failure = await execFileAsync(process.execPath, [
    "scripts/build-bundle.mjs", "--output", local.outputRoot, "--target", "linux-x64",
    "--runtime-manifest", resolve(import.meta.dirname, "../scripts/score-runtime-manifest.json"),
    "--runtime-cache", local.cacheRoot, "--runtime-offline"
  ], {
    cwd: resolve(import.meta.dirname, ".."),
    env: { ...process.env, NODE_ENV: "test", YT2SHEET_TEST_BUNDLE_FIXTURE_CONFIG: local.fixtureConfigPath }
  }).then(() => undefined, (error) => error);
  assert.match(String(failure), /local bundle fixture requires/);
  await assert.rejects(access(local.outputRoot));
  await assertNoBundleScratch(local.root);
  if (process.env.SCORE_RUNTIME_EVIDENCE_DIR) {
    await mkdir(process.env.SCORE_RUNTIME_EVIDENCE_DIR, { recursive: true });
    await writeFile(join(process.env.SCORE_RUNTIME_EVIDENCE_DIR, "production-manifest-crosshost-guard.json"), `${JSON.stringify({ exitCode: failure?.code, error: String(failure), stagingLeftovers: await bundleScratch(local.root) }, null, 2)}\n`, "utf8");
  }
});

for (const platformId of ["windows-2022-x64", "ubuntu-22.04-x64"]) {
  test(`stages ${platformId} runtimes through the build-time extraction command protocol`, async () => {
    // Given: local MSI or deb/AppImage fixture assets and native-command stand-ins.
    const local = await portableFixture(platformId);
    // When: the platform's pinned cache assets are staged.
    const result = await stageScoreRuntimes({
      manifestPath: local.manifestPath, platformId, targetRoot: local.targetRoot,
      cacheRoot: local.cacheRoot, offline: true, commands: local.commands,
      environment: { FIXTURE_ROOT: local.sourceRoot }
    });
    // Then: both discovered console executables pass their version probes.
    assert.deepEqual(result.versionProbes, { audiveris: "5.11.0", musescore: "4.7.4" });
    await access(join(local.targetRoot, "tools", "score-runtime-inventory.json"));
  });
}

test("rejects a corrupt offline cache without touching prior output", async () => {
  // Given: a cache entry whose bytes do not match the manifest digest.
  const local = await fixture();
  const manifest = JSON.parse(await readFile(local.manifestPath, "utf8"));
  await writeFile(join(local.cacheRoot, cacheFileName(manifest.platforms[0].runtimes.audiveris)), "corrupt", "utf8");
  // When/Then: staging rejects the digest and preserves the prior bundle.
  await assert.rejects(stage(local), /SHA-256/);
  await assertPriorOutputIsUntouched(local);
});

test("kills extraction while temporary growth exceeds the installed budget", async () => {
  // Given: an administrative extractor that creates an oversized sparse payload and keeps running.
  const local = await portableFixture("windows-2022-x64");
  await mkdir(local.targetRoot, { recursive: true });
  await writeFile(join(local.targetRoot, "prior-output"), "keep", "utf8");
  // When: the monitored extraction crosses 2 GiB before it completes.
  await assert.rejects(stageScoreRuntimes({
    manifestPath: local.manifestPath, platformId: local.platformId, targetRoot: local.targetRoot,
    cacheRoot: local.cacheRoot, offline: true, commands: local.commands,
    environment: { FIXTURE_ROOT: local.sourceRoot, OVERSIZE: "1" }
  }), /temporary extraction exceeds/);
  // Then: the child is killed, staging is cleaned, and prior output is unchanged.
  await assertPriorOutputIsUntouched(local);
});

test("rejects a missing executable without touching prior output", async () => {
  // Given: an extracted app without its manifest executable.
  const local = await fixture({ missingExecutable: "audiveris" });
  // When/Then: staging fails closed before commit.
  await assert.rejects(stage(local), /executable/i);
  await assertPriorOutputIsUntouched(local);
});

test("rejects an escaping symlink without touching prior output", async () => {
  // Given: a signed-app fixture containing an absolute traversal symlink.
  const local = await fixture({ traversal: "audiveris" });
  // When/Then: tree validation rejects it before commit.
  await assert.rejects(stage(local), /symlink|traversal/i);
  await assertPriorOutputIsUntouched(local);
});

test("rejects a symlink into transient extraction state without touching prior output", async () => {
  // Given: an app link that would be valid only while the staging scratch tree exists.
  const local = await fixture({ transientTraversal: "audiveris" });
  // When/Then: final-tree validation rejects the dangling transient link before commit.
  await assert.rejects(stage(local), /symlink/i);
  await assertPriorOutputIsUntouched(local);
});

test("rejects a lost executable bit without touching prior output", async () => {
  // Given: a Unix runtime whose declared executable lost every execute bit.
  const local = await fixture({ lostExecutableBit: "musescore" });
  // When/Then: staging rejects the permissions regression before commit.
  await assert.rejects(stage(local), /executable bit/i);
  await assertPriorOutputIsUntouched(local);
});

test("trusts signature command exit status rather than misleading output", async () => {
  // Given: signature commands that print success-looking text but exit non-zero.
  const local = await fixture();
  // When/Then: staging fails closed and preserves the prior bundle.
  await assert.rejects(stage(local, { environment: { FIXTURE_ROOT: local.fixtureRoot, SIGNATURE_FAIL: "1" } }), /codesign|command failed/i);
  await assertPriorOutputIsUntouched(local);
});

test("accepts a pinned ad hoc macOS app when Gatekeeper cannot assess the upstream image", async () => {
  // Given: the pinned archive has a valid ad hoc code signature but Gatekeeper rejects it.
  const local = await fixture();
  // When: staging validates the archive hash and strict code signature before the Gatekeeper check.
  const result = await stage(local, { environment: { FIXTURE_ROOT: local.fixtureRoot, ADHOC_SIGNATURE: "1", SPCTL_FAIL: "1" } });
  // Then: the known upstream runtime is staged without accepting an unsigned or unverified app.
  assert.deepEqual(result.versionProbes, { audiveris: "5.11.0", musescore: "4.7.4" });
});

test("rejects unsupported manifest targets without touching prior output", async () => {
  // Given: a platform identifier absent from the manifest.
  const local = await fixture();
  // When/Then: selection fails before extraction or commit.
  await assert.rejects(stage(local, { platformId: "ubuntu-99-x64" }), /unsupported/i);
  await assertPriorOutputIsUntouched(local);
});

test("cancellation terminates long extraction and cleans its temporary tree", async () => {
  // Given: an extraction command that does not complete and an abort signal.
  const local = await fixture();
  const controller = new AbortController();
  setImmediate(() => controller.abort());
  // When/Then: staging cancels and leaves neither output nor staging residue.
  await assert.rejects(stage(local, { signal: controller.signal, environment: { FIXTURE_ROOT: local.fixtureRoot, LONG_EXTRACTION: "1" } }), /abort/i);
  await assertPriorOutputIsUntouched(local);
});

test("times out long extraction and cleans its temporary tree", async () => {
  // Given: an extractor that exceeds the configured staging deadline.
  const local = await fixture();
  // When/Then: the deadline terminates it without replacing prior output.
  await assert.rejects(stage(local, { extractionTimeoutMs: 10, environment: { FIXTURE_ROOT: local.fixtureRoot, LONG_EXTRACTION: "1" } }), /abort/i);
  await assertPriorOutputIsUntouched(local);
});
