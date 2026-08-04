import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export async function createReleaseFixture() {
  const root = await mkdtemp(join(tmpdir(), "yt2sheet-installer-runtime-"));
  const release = join(root, "release");
  await mkdir(release);
  const specifications = [
    ["darwin-arm64", "macos-14-arm64", "17491af8b6d40153b031dd1f0815e37213f0999ef23f10586af46706e59b2eb6", "e3596e27da0806a3384cab67d52f8478ad21ed2bd6fc96d7cb874d840b016fac"],
    ["darwin-x64", "macos-14-x64", "11794424c6f1698617836a77d2c5818c46405a3fe7388281c623c4e383fa33cb", "e3596e27da0806a3384cab67d52f8478ad21ed2bd6fc96d7cb874d840b016fac"],
    ["linux-x64", "ubuntu-22.04-x64", "ae714594f40e54b1a4951fc3f914f08ae38fe5d07b7f2283b1a904fdb6e0a318", "9233ed1b87d3e6b45722278f3c286dcd41e83da778bd0f80a1dd04949696ad93"]
  ];
  const bundles = new Map();
  const checksumLines = [];
  for (const [target, platformId, audiverisSha256, musescoreSha256] of specifications) {
    const bundle = join(root, `bundle-${target}`);
    await createValidBundle(bundle, { target, platformId, audiverisSha256, musescoreSha256 });
    bundles.set(target, bundle);
    const asset = `yt2sheet-${target}.tar.gz`;
    const archived = spawnSync("tar", ["-czf", join(release, asset), "-C", bundle, "."], { encoding: "utf8" });
    assert.equal(archived.status, 0, archived.stderr);
    checksumLines.push(`${await sha256(join(release, asset))}  ${asset}`);
  }
  await writeFile(join(release, "checksums.txt"), `${checksumLines.join("\n")}\n`, "utf8");
  const hostTarget = process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  return { root, release, bundle: bundles.get(hostTarget) };
}

async function createValidBundle(bundle, specification) {
  for (const directory of ["runtime/bin", "app/dist-cli/cli", "bin", "tools/audiveris/bin", "tools/musescore/bin", "THIRD_PARTY/licenses"]) {
    await mkdir(join(bundle, directory), { recursive: true });
  }
  const launcher = `#!/bin/sh
set -eu
case "\${1:-}" in
  version) printf 'yt2sheet fixture-13\\n' ;;
  doctor) printf '{"status":"ok","offline":true}\\n' ;;
  structured-smoke) printf '{"decision":"structured","pages":1}\\n' > "$YT2SHEET_TEST_OUTPUT" ;;
  *) exit 2 ;;
esac
`;
  await writeFile(join(bundle, "bin", "yt2"), launcher, "utf8");
  await chmod(join(bundle, "bin", "yt2"), 0o755);
  await executable(join(bundle, "runtime/bin/node"), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
  await writeFile(join(bundle, "app/dist-cli/cli/index.js"), "// fixture CLI entry\n", "utf8");
  await executable(join(bundle, "tools/yt-dlp"), "#!/bin/sh\nprintf 'fixture-yt-dlp\\n'\n");
  const tools = [
    ["audiveris", "5.11.0", "tools/audiveris/bin/Audiveris", specification.audiverisSha256],
    ["musescore", "4.7.4", "tools/musescore/bin/MuseScore", specification.musescoreSha256]
  ];
  const entries = [];
  const archives = {};
  const versionProbes = {};
  for (const [tool, version, stagedExecutable, archiveSha256] of tools) {
    await executable(join(bundle, stagedExecutable), `#!/bin/sh\nprintf '${version}\\n'\n`);
    const item = await stat(join(bundle, stagedExecutable));
    entries.push({ path: stagedExecutable, mode: (item.mode & 0o7777).toString(8).padStart(4, "0"), type: "file", size: item.size, sha256: await sha256(join(bundle, stagedExecutable)) });
    archives[tool] = { assetName: `${tool}-fixture`, sha256: archiveSha256, extraction: "fixture", stagedExecutable };
    versionProbes[tool] = version;
  }
  await writeFile(join(bundle, "tools/score-runtime-inventory.json"), `${JSON.stringify({ schemaVersion: "score-runtime-inventory/1", platformId: specification.platformId, archives, versionProbes, entries }, null, 2)}\n`, "utf8");
  await writeFile(join(bundle, "VERSION"), `yt2sheet 0.2.18 ${specification.target}\n`, "utf8");
  await writeFile(join(bundle, "THIRD_PARTY/licenses/runtime.txt"), "fixture runtime licenses\n", "utf8");
  const artifacts = {
    "SOURCE_MANIFEST.json": `${JSON.stringify({ schemaVersion: "yt2sheet-source-manifest/1", sources: tools.map(([name, version]) => ({ name, version })) }, null, 2)}\n`,
    "THIRD_PARTY_NOTICES.md": "# Third-Party Notices\n\nFixture runtime notices.\n",
    "bom.cdx.json": `${JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.7", components: tools.map(([name, version]) => ({ type: "application", name, version })) }, null, 2)}\n`
  };
  for (const [name, source] of Object.entries(artifacts)) await writeFile(join(bundle, name), source, "utf8");
  await writeFile(join(bundle, "COMPLIANCE_SUMMARY.json"), `${JSON.stringify({
    schemaVersion: "yt2sheet-compliance-summary/1", componentCount: 2, licenseCount: 2,
    artifacts: Object.fromEntries(Object.entries(artifacts).map(([name, source]) => [name, createHash("sha256").update(source).digest("hex")]))
  }, null, 2)}\n`, "utf8");
}

export async function installFixture(fixture, scenarioRoot, scenario, failure) {
  await mkdir(scenarioRoot, { recursive: true });
  const home = join(scenarioRoot, "home"), fakeBin = join(scenarioRoot, "fake-bin");
  await mkdir(home, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  const environment = {
    ...process.env,
    HOME: home,
    YT2SHEET_INSTALL_ROOT: join(scenarioRoot, "install"),
    YT2SHEET_BIN_DIR: join(scenarioRoot, "bin"),
    YT2SHEET_PROFILE: join(home, ".profile"),
    YT2SHEET_RELEASE_BASE_URL: `file://${fixture.release}`,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`
  };
  if (scenario !== "macos") {
    await executable(join(fakeBin, "uname"), `#!/bin/sh\n[ "\${1:-}" = "-s" ] && printf 'Linux\\n' || printf 'x86_64\\n'\n`);
    const version = scenario.startsWith("ubuntu-") ? scenario.slice("ubuntu-".length) : "12";
    const id = scenario.startsWith("ubuntu-") ? "ubuntu" : "debian";
    const osRelease = join(scenarioRoot, "os-release");
    await writeFile(osRelease, `ID=${id}\nVERSION_ID=${version}\n`, "utf8");
    environment.YT2SHEET_OS_RELEASE_FILE = osRelease;
  }
  if (failure === "checksum") await badChecksumRelease(fixture, scenarioRoot, environment);
  if (failure === "extract") await badArchiveRelease(scenarioRoot, environment);
  if (failure?.startsWith("semantic-")) await badSemanticRelease(fixture, scenarioRoot, environment, failure);
  if (failure === "disk") {
    await executable(join(fakeBin, "df"), "#!/bin/sh\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/test 1 1 0 100%% /\\n'\n");
  }
  if (failure === "interrupt") {
    await executable(join(fakeBin, "tar"), '#!/bin/sh\nif [ "$1" = "-tzf" ]; then exec /usr/bin/tar "$@"; fi\nkill -TERM "$PPID"\nexit 143\n');
  }
  return spawnSync("sh", [resolve("scripts/install.sh")], { encoding: "utf8", env: environment, timeout: 15_000 });
}

async function badChecksumRelease(fixture, scenarioRoot, environment) {
  const release = join(scenarioRoot, "bad-checksum-release"), asset = darwinAsset();
  await mkdir(release);
  await writeFile(join(release, asset), await readFile(join(fixture.release, asset)));
  await writeFile(join(release, "checksums.txt"), `${"0".repeat(64)}  ${asset}\n`, "utf8");
  environment.YT2SHEET_RELEASE_BASE_URL = `file://${release}`;
}

async function badArchiveRelease(scenarioRoot, environment) {
  const release = join(scenarioRoot, "bad-archive-release"), asset = darwinAsset();
  await mkdir(release);
  await writeFile(join(release, asset), "not a tar archive\n", "utf8");
  await writeFile(join(release, "checksums.txt"), `${await sha256(join(release, asset))}  ${asset}\n`, "utf8");
  environment.YT2SHEET_RELEASE_BASE_URL = `file://${release}`;
}

async function badSemanticRelease(fixture, scenarioRoot, environment, failure) {
  const release = join(scenarioRoot, "bad-semantic-release"), bundle = join(scenarioRoot, "bad-semantic-bundle"), asset = darwinAsset();
  await mkdir(release);
  await cp(fixture.bundle, bundle, { recursive: true });
  if (failure === "semantic-version") await writeFile(join(bundle, "VERSION"), "not-a-version\n", "utf8");
  if (failure === "semantic-sbom") await writeFile(join(bundle, "bom.cdx.json"), "not-json\n", "utf8");
  if (failure === "semantic-runtime") await writeFile(join(bundle, "runtime/bin/node"), "", "utf8");
  if (failure === "semantic-tools") await writeFile(join(bundle, "tools/audiveris/bin/Audiveris"), "", "utf8");
  if (failure === "semantic-notices") await rm(join(bundle, "THIRD_PARTY_NOTICES.md"));
  if (failure === "semantic-inventory") await writeFile(join(bundle, "tools/score-runtime-inventory.json"), "{}\n", "utf8");
  if (failure === "semantic-license") await writeFile(join(bundle, "THIRD_PARTY/licenses/runtime.txt"), "", "utf8");
  const archived = spawnSync("tar", ["-czf", join(release, asset), "-C", bundle, "."], { encoding: "utf8" });
  assert.equal(archived.status, 0, archived.stderr);
  await writeFile(join(release, "checksums.txt"), `${await sha256(join(release, asset))}  ${asset}\n`, "utf8");
  environment.YT2SHEET_RELEASE_BASE_URL = `file://${release}`;
}

function darwinAsset() {
  return process.arch === "arm64" ? "yt2sheet-darwin-arm64.tar.gz" : "yt2sheet-darwin-x64.tar.gz";
}

async function executable(path, source) {
  await writeFile(path, source, "utf8");
  await chmod(path, 0o755);
}

export async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function pathExists(path) {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EISDIR") return true;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function writeEvidence(name, value) {
  const evidenceDirectory = process.env.TASK13_EVIDENCE_DIR;
  if (!evidenceDirectory) return;
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(join(evidenceDirectory, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
