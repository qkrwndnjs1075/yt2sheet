import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  installScoreRuntimes,
  maySkipToolInstall,
  resolveScoreRuntimePlatform,
  runPackageInstall
} from "../scripts/install-cli.mjs";
import {
  createReleaseFixture,
  installFixture,
  pathExists,
  sha256,
  writeEvidence
} from "./support/installer-runtime-fixture.mjs";

test("standalone installers require a supported complete runtime bundle and atomic replacement", async () => {
  // Given: the current cross-platform installer sources.
  const [shell, powershell] = await Promise.all([
    readFile("scripts/install.sh", "utf8"),
    readFile("scripts/install.ps1", "utf8")
  ]);

  // When: their install contracts are inspected.
  // Then: Linux is rejected before download and both replacements retain a rollback root.
  assert.match(shell, /\/etc\/os-release/);
  assert.match(shell, /22\.04\|24\.04/);
  assert.match(shell, /backup_root=/);
  assert.match(shell, /THIRD_PARTY_NOTICES\.md/);
  assert.match(shell, /bom\.cdx\.json/);
  assert.match(powershell, /backupRoot/);
  assert.match(powershell, /ZipFile.*OpenRead/);
  assert.match(powershell, /THIRD_PARTY_NOTICES\.md/);
  assert.match(powershell, /bom\.cdx\.json/);
});

test("local release fixtures install macOS and supported Ubuntu bundles with offline surfaces", async (t) => {
  // Given: one checksum-verified release fixture containing tools, licenses, SBOM, and fake CLI surfaces.
  const fixture = await createReleaseFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  // When: the shell installer runs as macOS, Ubuntu 22.04, and Ubuntu 24.04 in isolated roots.
  const observations = [];
  for (const scenario of ["macos", "ubuntu-22.04", "ubuntu-24.04"]) {
    const scenarioRoot = join(fixture.root, scenario);
    const installed = await installFixture(fixture, scenarioRoot, scenario);

    // Then: version, offline doctor, structured smoke, and complete bundle artifacts are observable.
    assert.equal(installed.status, 0, installed.stderr);
    const launcher = join(scenarioRoot, "bin", "yt2");
    const version = spawnSync(launcher, ["version"], { encoding: "utf8" });
    assert.equal(version.stdout.trim(), "yt2sheet fixture-13");
    const doctor = spawnSync(launcher, ["doctor", "--offline"], { encoding: "utf8" });
    assert.deepEqual(JSON.parse(doctor.stdout), { status: "ok", offline: true });
    const structuredOutput = join(scenarioRoot, "structured.json");
    const structured = spawnSync(launcher, ["structured-smoke"], {
      encoding: "utf8",
      env: { ...process.env, YT2SHEET_TEST_OUTPUT: structuredOutput }
    });
    assert.equal(structured.status, 0, structured.stderr);
    assert.deepEqual(JSON.parse(await readFile(structuredOutput, "utf8")), { decision: "structured", pages: 1 });
    for (const ownedPath of ["tools/audiveris", "tools/musescore", "THIRD_PARTY", "THIRD_PARTY_NOTICES.md", "bom.cdx.json"]) {
      assert.equal(await pathExists(join(scenarioRoot, "install", ownedPath)), true, ownedPath);
    }
    observations.push({
      scenario,
      installerExit: installed.status,
      installerStages: installed.stdout.match(/### \[\d\/7\]/gu)?.length ?? 0,
      version: version.stdout.trim(),
      doctor: JSON.parse(doctor.stdout),
      structured: JSON.parse(await readFile(structuredOutput, "utf8")),
      archiveSha256: await sha256(join(fixture.release, scenario === "macos"
        ? `yt2sheet-darwin-${process.arch === "arm64" ? "arm64" : "x64"}.tar.gz`
        : "yt2sheet-linux-x64.tar.gz"))
    });
  }
  await writeEvidence("release-fixture-matrix.json", observations);
});

test("standalone installer failures preserve the prior install and reject Linux before download", async (t) => {
  // Given: a valid release plus isolated prior installations with a stable ownership marker.
  const fixture = await createReleaseFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const cases = [
    "checksum", "extract", "disk", "interrupt", "semantic-version", "semantic-sbom",
    "semantic-runtime", "semantic-tools", "semantic-notices", "semantic-inventory", "semantic-license"
  ];
  const preservation = [];

  // When: checksum, extraction, disk-budget, and signal-interruption failures are induced.
  for (const failure of cases) {
    const scenarioRoot = join(fixture.root, `negative-${failure}`);
    const installRoot = join(scenarioRoot, "install");
    await mkdir(installRoot, { recursive: true });
    await writeFile(join(installRoot, "prior.txt"), "prior-install-v1\n", "utf8");
    const before = await sha256(join(installRoot, "prior.txt"));
    const result = await installFixture(fixture, scenarioRoot, "macos", failure);

    // Then: the command is nonzero and the exact previous bytes remain installed.
    assert.notEqual(result.status, 0, failure);
    assert.equal(await sha256(join(installRoot, "prior.txt")), before, failure);
    assert.deepEqual((await readdir(scenarioRoot)).filter((name) => name.startsWith(".yt2sheet-")), [], failure);
    preservation.push({ failure, exit: result.status, before, after: await sha256(join(installRoot, "prior.txt")) });
  }

  const unsupportedRoot = join(fixture.root, "unsupported-linux");
  const unsupported = await installFixture(fixture, unsupportedRoot, "debian-12");
  assert.notEqual(unsupported.status, 0);
  assert.match(unsupported.stderr, /Ubuntu 22\.04\/24\.04/);
  assert.doesNotMatch(unsupported.stdout, /\[1\/7\]/, "unsupported Linux must fail before the download stage");
  preservation.push({ failure: "unsupported-linux", exit: unsupported.status, downloadStages: 0 });
  await writeEvidence("negative-preservation-matrix.json", preservation);
});

test("npm bootstrap selects the pinned target, keeps package ownership, and preserves tools on failure", async (t) => {
  // Given: package-owned roots and distinct previous runtime bytes.
  const root = await mkdtemp(join(tmpdir(), "yt2sheet-npm-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(join(root, "scripts", "score-runtime-manifest.json"), "{}\n", "utf8");
  await mkdir(join(root, "tools", "audiveris"), { recursive: true });
  await writeFile(join(root, "tools", "audiveris", "prior.bin"), "prior-runtime\n", "utf8");
  const previousHash = await sha256(join(root, "tools", "audiveris", "prior.bin"));
  const observed = [];

  // When: a successful target-specific bootstrap is invoked through the package hook seam.
  const installed = await installScoreRuntimes({
    packageRoot: root,
    platform: "linux",
    architecture: "x64",
    environment: {},
    readText: async () => 'ID="ubuntu"\nVERSION_ID="24.04"\n',
    stageRuntimes: async (options) => {
      observed.push(options);
      await mkdir(join(options.targetRoot, "tools", "musescore"), { recursive: true });
      return { platformId: options.platformId };
    }
  });

  // Then: the manifest/target/cache all stay below the package root and Ubuntu 24.04 is explicit.
  assert.equal(installed.platformId, "ubuntu-24.04-x64");
  assert.equal(observed.length, 1);
  assert.equal(observed[0].manifestPath, join(root, "scripts", "score-runtime-manifest.json"));
  assert.equal(observed[0].targetRoot, root);
  assert.equal(observed[0].cacheRoot.startsWith(root), true);
  assert.equal(await pathExists(observed[0].cacheRoot), false);

  await assert.rejects(
    installScoreRuntimes({
      packageRoot: root,
      platform: "linux",
      architecture: "x64",
      environment: {},
      readText: async () => "ID=ubuntu\nVERSION_ID=22.04\n",
      stageRuntimes: async () => { throw new Error("fixture npm download failed"); }
    }),
    /fixture npm download failed/
  );
  assert.equal(await sha256(join(root, "tools", "audiveris", "prior.bin")), previousHash);
  await writeEvidence("npm-bootstrap.json", {
    platformId: installed.platformId,
    manifestPath: observed[0].manifestPath,
    targetRoot: observed[0].targetRoot,
    cacheRemoved: !(await pathExists(observed[0].cacheRoot)),
    priorHashAfterFailure: await sha256(join(root, "tools", "audiveris", "prior.bin"))
  });
});

test("npm skip is CI/development-only and leaves score tools absent", async (t) => {
  // Given: an empty package fixture and a stage callback that would make tool installation observable.
  const root = await mkdtemp(join(tmpdir(), "yt2sheet-npm-skip-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let staged = false;

  // When: CI uses the explicit skip and a normal user attempts the same flag.
  await runPackageInstall({
    packageRoot: root,
    environment: { CI: "true", YT2SHEET_SKIP_TOOL_INSTALL: "1" },
    stageRuntimes: async () => { staged = true; }
  });

  // Then: CI leaves the tools absent, while a normal install receives a hard actionable failure.
  assert.equal(staged, false);
  assert.equal(await pathExists(join(root, "tools")), false);
  assert.equal(maySkipToolInstall({ NODE_ENV: "development" }), true);
  assert.equal(maySkipToolInstall({}), false);
  await assert.rejects(
    runPackageInstall({ packageRoot: root, environment: { YT2SHEET_SKIP_TOOL_INSTALL: "1" } }),
    /allowed only in CI or NODE_ENV=development/
  );
});

test("npm Linux target selection rejects unsupported distributions and architectures", async () => {
  // Given: the package target resolver at its external OS boundary.
  const readUbuntu22 = async () => "ID=ubuntu\nVERSION_ID=22.04\n";
  const readUbuntu24 = async () => "ID=ubuntu\nVERSION_ID=24.04\n";

  // When/Then: the exact supported matrix resolves and adjacent targets reject.
  assert.equal(await resolveScoreRuntimePlatform({ platform: "win32", architecture: "x64" }), "windows-2022-x64");
  assert.equal(await resolveScoreRuntimePlatform({ platform: "darwin", architecture: "arm64" }), "macos-14-arm64");
  assert.equal(await resolveScoreRuntimePlatform({ platform: "linux", architecture: "x64", readText: readUbuntu22 }), "ubuntu-22.04-x64");
  assert.equal(await resolveScoreRuntimePlatform({ platform: "linux", architecture: "x64", readText: readUbuntu24 }), "ubuntu-24.04-x64");
  await assert.rejects(
    resolveScoreRuntimePlatform({ platform: "linux", architecture: "x64", readText: async () => "ID=debian\nVERSION_ID=12\n" }),
    /require Ubuntu 22\.04\/24\.04 x64/
  );
  await assert.rejects(resolveScoreRuntimePlatform({ platform: "linux", architecture: "arm64" }), /do not support linux-arm64/);
});


test("npm postinstall stages pinned score runtimes and fails outside an approved skip context", async () => {
  // Given: the npm package bootstrap and package manifest.
  const [bootstrap, packageSource] = await Promise.all([
    readFile("scripts/install-cli.mjs", "utf8"),
    readFile("package.json", "utf8")
  ]);

  // When: the shipped bootstrap contract is inspected.
  // Then: it owns score runtime staging and ships every module needed to run it.
  assert.match(bootstrap, /stageScoreRuntimes/);
  assert.match(bootstrap, /score-runtime-manifest\.json/);
  assert.match(bootstrap, /CI|development/);
  assert.doesNotMatch(bootstrap, /score runtime.*first run/i);
  const packageJson = JSON.parse(packageSource);
  assert.ok(packageJson.files.includes("scripts/fetch-score-runtimes.mjs"));
  assert.ok(packageJson.files.includes("scripts/score-runtime-staging-io.mjs"));
});
