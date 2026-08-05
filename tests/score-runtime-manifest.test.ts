import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  loadScoreRuntimeManifest,
  parseScoreRuntimeManifest,
  resolveScoreRuntimeTarget,
  ScoreRuntimeManifestError
} from "../pipeline/score-runtime-manifest";

const manifestPath = resolve(process.cwd(), "scripts/score-runtime-manifest.json");

test("loads exact release targets and probes when the checked-in contract is valid", async () => {
  // Given: the checked-in manifest
  // When: it crosses the file and schema boundary
  const manifest = await loadScoreRuntimeManifest(manifestPath);

  // Then: the four bundle targets and five supported OS records are exact
  assert.deepEqual(manifest.releaseTargets, ["darwin-arm64", "darwin-x64", "linux-x64", "windows-x64"]);
  assert.deepEqual(manifest.platforms.map(({ id }) => id), ["macos-14-arm64", "macos-14-x64", "ubuntu-22.04-x64", "ubuntu-24.04-x64", "windows-2022-x64"]);
  for (const platform of manifest.platforms) {
    assert.deepEqual(platform.runtimes.audiveris.versionProbe, { args: ["-version"], expected: "5.11.0" });
    assert.deepEqual(platform.runtimes.musescore.versionProbe, { args: ["--version"], expected: "4.7.4" });
    assert.notEqual(platform.runtimes.audiveris.stagedExecutable, platform.runtimes.musescore.stagedExecutable);
  }
});

test("pins the actual MuseScore macOS application bundle name", async () => {
  // Given: the checked-in runtime manifest for supported macOS targets.
  const manifest = await loadScoreRuntimeManifest(manifestPath);
  // When: the MuseScore app path is resolved for each macOS architecture.
  const macos = manifest.platforms.filter(({ id }) => id.startsWith("macos-"));
  // Then: it matches the app bundle shipped by MuseScore Studio 4.7.4.
  assert.equal(macos.length, 2);
  for (const platform of macos) {
    assert.equal(platform.runtimes.musescore.stagedExecutable, "tools/musescore/MuseScore 4.app/Contents/MacOS/mscore");
  }
});

test("resolves every declared MusicXML schema bundled path to a packaged file", async () => {
  // Given: the checked-in validated manifest
  const manifest = await loadScoreRuntimeManifest(manifestPath);

  // When: each schema bundled path is resolved from the package root
  const resolvedPaths = manifest.standards.musicXml.schemas.map(({ bundledPath }) => resolve(process.cwd(), bundledPath));
  await Promise.all(resolvedPaths.map((bundledPath) => access(bundledPath)));

  // Then: all six declared schema files exist at their runtime paths
  assert.equal(resolvedPaths.length, 6);
});

const invalidCases: readonly { readonly name: string; readonly mutate: (source: string) => string }[] = [
  { name: "changed upstream tag", mutate: (source) => source.replace('"tag": "5.11.0"', '"tag": "5.11.1"') },
  { name: "wrong but well-formed digest", mutate: (source) => source.replace("17491af8b6d40153b031dd1f0815e37213f0999ef23f10586af46706e59b2eb6", "07491af8b6d40153b031dd1f0815e37213f0999ef23f10586af46706e59b2eb6") },
  { name: "missing digest", mutate: (source) => source.replace('"sha256": "17491af8b6d40153b031dd1f0815e37213f0999ef23f10586af46706e59b2eb6"', '"sha256": ""') },
  { name: "unknown release target", mutate: (source) => source.replace('"windows-x64"]', '"plan9-x64"]') },
  { name: "non-HTTPS asset URL", mutate: (source) => source.replace("https://github.com/Audiveris/audiveris/releases/download/5.11.0/", "http://github.com/Audiveris/audiveris/releases/download/5.11.0/") },
  { name: "floating latest asset URL", mutate: (source) => source.replace("releases/download/5.11.0/Audiveris-5.11.0", "releases/download/latest/Audiveris-5.11.0") },
  { name: "duplicate staged executable", mutate: (source) => source.replace("tools/musescore/bin/MuseScore4.exe", "tools/audiveris/bin/Audiveris.exe") },
  { name: "absent license record", mutate: (source) => source.replace('"license": {\n        "spdx": "AGPL-3.0-only"', '"removedLicense": {\n        "spdx": "AGPL-3.0-only"') },
  { name: "absent source record", mutate: (source) => source.replace('"source": {\n        "repositoryUrl": "https://github.com/Audiveris/audiveris"', '"removedSource": {\n        "repositoryUrl": "https://github.com/Audiveris/audiveris"') },
  { name: "floating npm dependency", mutate: (source) => source.replace('"libxml2-wasm": "0.7.1"', '"libxml2-wasm": "^0.7.1"') },
  { name: "unpinned MusicXML schema commit", mutate: (source) => source.replace('"commit": "799e2defb2ece0ae7bafe08dcbcac25b2c631d53"', '"commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"') }
];

for (const invalidCase of invalidCases) {
  test(`rejects ${invalidCase.name}`, async () => {
    // Given: one independently tampered manifest field
    const source = await readFile(manifestPath, "utf8");

    // When/Then: parsing fails closed at the local schema boundary
    assert.throws(() => parseScoreRuntimeManifest(JSON.parse(invalidCase.mutate(source))), ScoreRuntimeManifestError);
  });
}

test("rejects malformed JSON before returning a runtime contract", async () => {
  // Given: a local malformed manifest
  const root = await mkdtemp(join(tmpdir(), "yt2sheet-runtime-manifest-malformed-"));
  const path = join(root, "manifest.json");
  await writeFile(path, "{", "utf8");

  // When/Then: loading reports the typed boundary error
  await assert.rejects(loadScoreRuntimeManifest(path), ScoreRuntimeManifestError);
  await rm(root, { recursive: true, force: true });
});

test("reloads from disk and rejects stale-state tampering", async () => {
  // Given: a valid temporary manifest that has already been loaded
  const root = await mkdtemp(join(tmpdir(), "yt2sheet-runtime-manifest-reload-"));
  const path = join(root, "manifest.json");
  const source = await readFile(manifestPath, "utf8");
  await writeFile(path, source, "utf8");
  await loadScoreRuntimeManifest(path);

  // When: the on-disk digest changes after the first load
  await writeFile(path, invalidCases[1]?.mutate(source) ?? source, "utf8");

  // Then: the next load reads current state and fails rather than returning cached success
  await assert.rejects(loadScoreRuntimeManifest(path), ScoreRuntimeManifestError);
  await rm(root, { recursive: true, force: true });
});

test("resolves targets deterministically when manifest records are reordered", async () => {
  // Given: equivalent validated manifests with opposite platform ordering
  const manifest = await loadScoreRuntimeManifest(manifestPath);
  const reordered = parseScoreRuntimeManifest({ ...manifest, platforms: [...manifest.platforms].reverse() });

  // When: the same Ubuntu runtime is resolved from both
  const first = resolveScoreRuntimeTarget(manifest, "linux-x64", "24.04");
  const second = resolveScoreRuntimeTarget(reordered, "linux-x64", "24.04");

  // Then: canonical JSON is byte-identical and independent of input ordering
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("rejects ambiguous Linux resolution without an OS version", async () => {
  // Given: Linux has separately pinned Ubuntu 22.04 and 24.04 records
  const manifest = await loadScoreRuntimeManifest(manifestPath);

  // When/Then: callers cannot silently select one platform record
  assert.throws(() => resolveScoreRuntimeTarget(manifest, "linux-x64"), ScoreRuntimeManifestError);
});
