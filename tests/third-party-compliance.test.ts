import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const fixtureRoot = resolve("tests/fixtures/third-party-compliance");
const generatorPath = resolve("scripts/generate-third-party-compliance.mjs");

async function createScenario(): Promise<{ readonly root: string; readonly bundle: string; readonly manifest: string; readonly packageLock: string; readonly output: string }> {
  const root = await mkdtemp(join(tmpdir(), "yt2sheet-compliance-"));
  const bundle = join(root, "bundle");
  const manifest = join(root, "manifest.json");
  const packageLock = join(root, "package-lock.json");
  await cp(join(fixtureRoot, "bundle"), bundle, { recursive: true });
  await cp(join(fixtureRoot, "manifest.json"), manifest);
  await cp(resolve("package-lock.json"), packageLock);
  return { root, bundle, manifest, packageLock, output: join(root, "generated") };
}

function runGenerator(scenario: { readonly bundle: string; readonly manifest: string; readonly packageLock: string; readonly output: string }) {
  return spawnSync(process.execPath, [generatorPath, "--manifest", scenario.manifest, "--package-lock", scenario.packageLock, "--bundle", scenario.bundle, "--output", scenario.output], {
    encoding: "utf8"
  });
}

async function createProductionScenario(): Promise<{ readonly root: string; readonly bundle: string; readonly runtimeManifest: string; readonly packageLock: string; readonly output: string }> {
  const fixture = await createScenario();
  const runtimeManifest = join(fixture.root, "score-runtime-manifest.json");
  await cp(resolve("scripts/score-runtime-manifest.json"), runtimeManifest);
  await rm(join(fixture.bundle, "THIRD_PARTY"), { recursive: true, force: true });
  const requiredInputs = [
    "THIRD_PARTY/licenses/Audiveris-LICENSE",
    "THIRD_PARTY/licenses/MuseScore-LICENSE.txt",
    "THIRD_PARTY/fonts/Bravura-OFL.txt",
    "THIRD_PARTY/fonts/Leland-LICENSE.txt",
    "THIRD_PARTY/sources/audiveris-9e1e55cd2746037d059345881c53e6a6754bffbd.tar.gz",
    "THIRD_PARTY/sources/musescore-7688c005ad963ba09ee715aae53dbc7e8c9d5ef8.tar.gz"
  ];
  for (const path of requiredInputs) {
    await mkdir(join(fixture.bundle, path, ".."), { recursive: true });
    await cp(join(fixtureRoot, "bundle", path), join(fixture.bundle, path));
  }
  await mkdir(join(fixture.bundle, "tools/audiveris/runtime/legal/java.base"), { recursive: true });
  await writeFile(join(fixture.bundle, "tools/audiveris/runtime/legal/java.base/LICENSE"), "JRE license notice fixture\n", "utf8");
  await mkdir(join(fixture.bundle, "tools/musescore/lib"), { recursive: true });
  await writeFile(join(fixture.bundle, "tools/musescore/lib/NOTICE"), "native library notice fixture\n", "utf8");
  return { root: fixture.root, bundle: fixture.bundle, runtimeManifest, packageLock: fixture.packageLock, output: fixture.output };
}

function runProductionGenerator(scenario: { readonly bundle: string; readonly runtimeManifest: string; readonly packageLock: string; readonly output: string }) {
  return spawnSync(process.execPath, [generatorPath, "--runtime-manifest", scenario.runtimeManifest, "--platform", "macos-14-arm64", "--package-lock", scenario.packageLock, "--bundle", scenario.bundle, "--output", scenario.output, "--offline"], { encoding: "utf8" });
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

test("generates deterministic notices, source assets, and CycloneDX 1.7 JSON from a complete bundle", async () => {
  // Given: a local manifest covering tools, a JRE, native code, and both required music fonts
  const scenario = await createScenario();
  await mkdir(scenario.output, { recursive: true });
  await writeFile(join(scenario.output, "stale.txt"), "must disappear\n", "utf8");

  // When: the release-facing generator runs twice from identical inputs
  const first = runGenerator(scenario);
  assert.equal(first.status, 0, first.stderr);
  const firstSummary = await readFile(join(scenario.output, "COMPLIANCE_SUMMARY.json"), "utf8");
  const firstArtifactHashes = await Promise.all([
    sha256(join(scenario.output, "THIRD_PARTY_NOTICES.md")),
    sha256(join(scenario.output, "bom.cdx.json")),
    sha256(join(scenario.output, "SOURCE_MANIFEST.json"))
  ]);
  const second = runGenerator(scenario);

  // Then: stale output is replaced and the machine-consumed artifacts remain byte-identical
  assert.equal(second.status, 0, second.stderr);
  await assert.rejects(readFile(join(scenario.output, "stale.txt")), { code: "ENOENT" });
  assert.equal(await readFile(join(scenario.output, "COMPLIANCE_SUMMARY.json"), "utf8"), firstSummary);
  assert.deepEqual(await Promise.all([
    sha256(join(scenario.output, "THIRD_PARTY_NOTICES.md")),
    sha256(join(scenario.output, "bom.cdx.json")),
    sha256(join(scenario.output, "SOURCE_MANIFEST.json"))
  ]), firstArtifactHashes);

  const bom = JSON.parse(await readFile(join(scenario.output, "bom.cdx.json"), "utf8"));
  assert.equal(bom.bomFormat, "CycloneDX");
  assert.equal(bom.specVersion, "1.7");
  assert.equal(bom.components.length, 14);
  assert.deepEqual(bom.components.map((component: { readonly purl: string }) => component.purl), [
    "pkg:generic/audiveris@5.11.0",
    "pkg:generic/bravura@1.392",
    "pkg:generic/example-native@1.0.0",
    "pkg:generic/leland@0.80",
    "pkg:generic/musescore@4.7.4",
    "pkg:generic/temurin@21.0.8%2B9",
    "pkg:npm/%40ffprobe-installer/ffprobe@2.1.2",
    "pkg:npm/fflate@0.8.3",
    "pkg:npm/ffmpeg-static@5.3.0",
    "pkg:npm/libxml2-wasm@0.7.1",
    "pkg:npm/pdf-lib@1.17.1",
    "pkg:npm/pino@10.3.1",
    "pkg:npm/sharp@0.35.3",
    "pkg:npm/zod@4.4.3"
  ].sort());
  assert.equal(bom.dependencies.length, 15);
  const directPackages = bom.components.filter((component: { readonly properties?: readonly { readonly name: string }[] }) => component.properties?.some(({ name }) => name === "yt2sheet:npm:requested"));
  assert.equal(directPackages.length, 8);
  assert.ok(directPackages.every((component: { readonly hashes: readonly { readonly alg: string; readonly content: string }[] }) => component.hashes.some(({ alg, content }) => alg === "SHA-512" && /^[a-f0-9]{128}$/.test(content))));
  const sourceManifest = JSON.parse(await readFile(join(scenario.output, "SOURCE_MANIFEST.json"), "utf8"));
  assert.equal(sourceManifest.sources.length, 6);
  for (const source of sourceManifest.sources) {
    assert.equal(await sha256(join(scenario.output, source.releaseAsset)), source.sha256);
  }
  assert.match(await readFile(join(scenario.output, "THIRD_PARTY_NOTICES.md"), "utf8"), /not legal advice/i);
  await rm(scenario.root, { recursive: true, force: true });
});

test("derives release metadata from the pinned runtime manifest and package lock", async () => {
  // Given: staged runtime files plus offline compliance inputs at runtime-manifest paths
  const scenario = await createProductionScenario();

  // When: the production CLI derives and generates the compliance artifacts
  const result = runProductionGenerator(scenario);

  // Then: primary commits, font snapshots, runtime notices, and direct packages come from production inputs
  assert.equal(result.status, 0, result.stderr);
  const bom = JSON.parse(await readFile(join(scenario.output, "bom.cdx.json"), "utf8"));
  assert.equal(bom.components.length, 12);
  assert.ok(bom.components.some((component: { readonly purl: string }) => component.purl === "pkg:generic/audiveris@5.11.0"));
  assert.ok(bom.components.some((component: { readonly purl: string }) => component.purl === "pkg:generic/bravura@4.7.4%2Bbundled"));
  const sourceManifest = JSON.parse(await readFile(join(scenario.output, "SOURCE_MANIFEST.json"), "utf8"));
  assert.ok(sourceManifest.sources.some((source: { readonly name: string; readonly commit: string }) => source.name === "Audiveris" && source.commit === "9e1e55cd2746037d059345881c53e6a6754bffbd"));
  assert.equal(sourceManifest.directPackages.length, 8);
  assert.equal(await readFile(join(scenario.output, "THIRD_PARTY/notices/audiveris/runtime/legal/java.base/LICENSE"), "utf8"), "JRE license notice fixture\n");
  assert.equal(await readFile(join(scenario.output, "THIRD_PARTY/notices/musescore/lib/NOTICE"), "utf8"), "native library notice fixture\n");
  await rm(scenario.root, { recursive: true, force: true });
});

test("derives compliance metadata when a signed app contains a directory symlink", async () => {
  // Given: a production-shaped app tree with a contained framework-style directory link.
  const scenario = await createProductionScenario();
  await symlink(".", join(scenario.bundle, "tools/audiveris/runtime-link"));

  // When: the production compliance path inventories the signed runtime bundle.
  const result = runProductionGenerator(scenario);

  // Then: the link is represented by its own target bytes instead of being opened as a directory.
  assert.equal(result.status, 0, result.stderr);
  await rm(scenario.root, { recursive: true, force: true });
});

test("accepts a signed app entry whose filename contains a JVM dollar sign", async () => {
  // Given: a normal Java class filename from the official Audiveris app bundle.
  const scenario = await createScenario();
  const path = "tools/audiveris/CLI$BookTask.class";
  const bytes = "signed Java class fixture\n";
  await writeFile(join(scenario.bundle, path), bytes, "utf8");
  const manifest = JSON.parse(await readFile(scenario.manifest, "utf8"));
  const audiveris = manifest.components.find((component: { readonly name: string }) => component.name === "Audiveris");
  audiveris.bundledFiles.push({ path, sha256: createHash("sha256").update(bytes).digest("hex") });
  await writeFile(scenario.manifest, JSON.stringify(manifest), "utf8");

  // When: the release-facing generator validates the fully mapped app tree.
  const result = runGenerator(scenario);

  // Then: a normal, non-traversing JVM filename is accepted.
  assert.equal(result.status, 0, result.stderr);
  await rm(scenario.root, { recursive: true, force: true });
});

test("copies a symlinked JVM notice as its verified notice text", async () => {
  // Given: the contained legal-directory link shape in the official bundled JRE.
  const scenario = await createProductionScenario();
  const legal = join(scenario.bundle, "tools/audiveris/runtime/legal");
  await mkdir(join(legal, "java.datatransfer"), { recursive: true });
  await writeFile(join(legal, "java.base/NOTICE"), "JRE notice fixture\n", "utf8");
  await symlink("../java.base/NOTICE", join(legal, "java.datatransfer/NOTICE"));

  // When: production compliance collects embedded runtime notices.
  const result = runProductionGenerator(scenario);

  // Then: output records the target text under the matching notice path.
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(scenario.output, "THIRD_PARTY/notices/audiveris/runtime/legal/java.datatransfer/NOTICE"), "utf8"), "JRE notice fixture\n");
  await rm(scenario.root, { recursive: true, force: true });
});

test("blocks offline production generation when a pinned source archive is absent", async () => {
  // Given: a prior output and an offline staged bundle missing the runtime-manifest Audiveris source path
  const scenario = await createProductionScenario();
  await mkdir(scenario.output, { recursive: true });
  await writeFile(join(scenario.output, "prior.txt"), "prior output\n", "utf8");
  await rm(join(scenario.bundle, "THIRD_PARTY/sources/audiveris-9e1e55cd2746037d059345881c53e6a6754bffbd.tar.gz"));

  // When: production compliance generation runs offline
  const result = runProductionGenerator(scenario);

  // Then: the exact runtime-manifest path blocks release and prior output survives
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /offline compliance input is missing.*audiveris-9e1e55/);
  assert.equal(await readFile(join(scenario.output, "prior.txt"), "utf8"), "prior output\n");
  await rm(scenario.root, { recursive: true, force: true });
});

test("blocks an offline production license that differs from its pinned upstream bytes", async () => {
  // Given: a staged production bundle with a modified Audiveris license at the correct path
  const scenario = await createProductionScenario();
  await writeFile(join(scenario.bundle, "THIRD_PARTY/licenses/Audiveris-LICENSE"), "modified\n", "utf8");

  // When: production metadata is derived from the pinned runtime manifest
  const result = runProductionGenerator(scenario);

  // Then: exact upstream identity blocks compliance publication
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pinned compliance input SHA-256 mismatch.*Audiveris-LICENSE/);
  await rm(scenario.root, { recursive: true, force: true });
});

test("rejects forged production tool versions even when probe expectations match", async () => {
  // Given: runtime tool versions and every selected-platform probe expectation are forged together.
  const scenario = await createProductionScenario();
  const runtime = JSON.parse(await readFile(scenario.runtimeManifest, "utf8"));
  runtime.tools.audiveris.version = "9.9.9";
  runtime.tools.musescore.version = "9.9.9";
  const platform = runtime.platforms.find(({ id }: { readonly id: string }) => id === "macos-14-arm64");
  platform.runtimes.audiveris.versionProbe.expected = "9.9.9";
  platform.runtimes.musescore.versionProbe.expected = "9.9.9";
  await writeFile(scenario.runtimeManifest, JSON.stringify(runtime), "utf8");

  // When: production compliance derivation crosses the independently pinned identity boundary.
  const result = runProductionGenerator(scenario);

  // Then: mutually consistent forged values still block artifact publication.
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unpinned.*version/i);
  await assert.rejects(readFile(join(scenario.output, "COMPLIANCE_SUMMARY.json")), { code: "ENOENT" });
  await rm(scenario.root, { recursive: true, force: true });
});

const manifestTamperingCases: readonly { readonly name: string; readonly mutate: (source: string) => string; readonly expected: RegExp }[] = [
  {
    name: "an altered purl",
    mutate: (source) => source.replace('"purl": "pkg:generic/audiveris@5.11.0"', '"purl": "pkg:generic/audiveris@5.12.0"'),
    expected: /purl version must match component version/
  },
  {
    name: "a missing source mapping",
    mutate: (source) => source.replace('"source": { "kind": "archive"', '"removedSource": { "kind": "archive"'),
    expected: /source mapping is required/
  },
  {
    name: "an invalid SPDX identifier",
    mutate: (source) => source.replace("AGPL-3.0-only", "AGPL-3.0-ish"),
    expected: /unsupported SPDX identifier/
  },
  {
    name: "a malformed notice filename",
    mutate: (source) => source.replace("THIRD_PARTY/notices/Temurin-NOTICE", "../Temurin-NOTICE"),
    expected: /safe bundle-relative path/
  }
];

for (const tamperingCase of manifestTamperingCases) {
  test(`blocks ${tamperingCase.name}`, async () => {
    // Given: one independently corrupted manifest field
    const scenario = await createScenario();
    const source = await readFile(scenario.manifest, "utf8");
    await writeFile(scenario.manifest, tamperingCase.mutate(source), "utf8");

    // When: generation crosses the manifest boundary
    const result = runGenerator(scenario);

    // Then: the process fails explicitly and leaves no success artifact
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, tamperingCase.expected);
    await assert.rejects(readFile(join(scenario.output, "COMPLIANCE_SUMMARY.json")), { code: "ENOENT" });
    await rm(scenario.root, { recursive: true, force: true });
  });
}

test("blocks generation when the Bravura OFL text is absent", async () => {
  // Given: a manifest that requires the Bravura OFL but a bundle missing that exact file
  const scenario = await createScenario();
  await rm(join(scenario.bundle, "THIRD_PARTY/fonts/Bravura-OFL.txt"));

  // When: generation verifies the licensed bundle
  const result = runGenerator(scenario);

  // Then: the named required license is reported rather than a false success log
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Bravura.*license file is missing/);
  assert.doesNotMatch(result.stdout, /generated successfully/i);
  await rm(scenario.root, { recursive: true, force: true });
});

test("reports both a missing Bravura OFL and an altered purl in one blocked run", async () => {
  // Given: one bundle is missing the required Bravura OFL while its manifest also has an altered purl.
  const scenario = await createScenario();
  await rm(join(scenario.bundle, "THIRD_PARTY/fonts/Bravura-OFL.txt"));
  const source = await readFile(scenario.manifest, "utf8");
  await writeFile(scenario.manifest, source.replace('"purl": "pkg:generic/audiveris@5.11.0"', '"purl": "pkg:generic/audiveris@5.12.0"'), "utf8");

  // When: both independent compliance defects cross the release boundary together.
  const result = runGenerator(scenario);

  // Then: one nonzero result identifies both defects and publishes no summary.
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /purl version must match component version/);
  assert.match(result.stderr, /Bravura.*license file is missing/);
  await assert.rejects(readFile(join(scenario.output, "COMPLIANCE_SUMMARY.json")), { code: "ENOENT" });
  await rm(scenario.root, { recursive: true, force: true });
});

test("blocks a modified pinned Audiveris license text", async () => {
  // Given: the pinned license path exists but its upstream bytes were changed
  const scenario = await createScenario();
  await writeFile(join(scenario.bundle, "THIRD_PARTY/licenses/Audiveris-LICENSE"), "modified license\n", "utf8");

  // When: license identity is verified
  const result = runGenerator(scenario);

  // Then: the exact license hash gate prevents artifact publication
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Audiveris license SHA-256 mismatch/);
  await rm(scenario.root, { recursive: true, force: true });
});

test("blocks a bundled third-party notice with no manifest owner", async () => {
  // Given: an extra native notice exists outside the complete manifest inventory
  const scenario = await createScenario();
  await writeFile(join(scenario.bundle, "THIRD_PARTY/notices/Unmapped-NOTICE"), "unmapped\n", "utf8");

  // When: the generator reconciles all bundled compliance inputs
  const result = runGenerator(scenario);

  // Then: the all-notices gate rejects the uncovered file
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /every bundled THIRD_PARTY license, notice, font notice, and source asset/);
  await rm(scenario.root, { recursive: true, force: true });
});

test("blocks an unresolved direct npm license without replacing prior output", async () => {
  // Given: a prior generated output and a lockfile dependency with an unreviewed license value
  const scenario = await createScenario();
  await mkdir(scenario.output, { recursive: true });
  await writeFile(join(scenario.output, "prior.txt"), "preserve me\n", "utf8");
  const lock = await readFile(scenario.packageLock, "utf8");
  await writeFile(scenario.packageLock, lock.replaceAll('"license": "LGPL-2.1"', '"license": "Unknown-Proprietary"'), "utf8");

  // When: package-lock metadata crosses the compliance boundary
  const result = runGenerator(scenario);

  // Then: release generation blocks and the prior output remains byte-identical
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsupported direct dependency license/);
  assert.equal(await readFile(join(scenario.output, "prior.txt"), "utf8"), "preserve me\n");
  await rm(scenario.root, { recursive: true, force: true });
});

test("blocks malformed compliance manifest JSON", async () => {
  // Given: a truncated manifest rather than a parsed compliance contract
  const scenario = await createScenario();
  await writeFile(scenario.manifest, "{", "utf8");

  // When: the generator reads the file boundary
  const result = runGenerator(scenario);

  // Then: malformed JSON is explicit and no generated summary exists
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /manifest contains malformed JSON/);
  await assert.rejects(readFile(join(scenario.output, "COMPLIANCE_SUMMARY.json")), { code: "ENOENT" });
  await rm(scenario.root, { recursive: true, force: true });
});

test("blocks an ISO normative PDF referenced as compliance material", async () => {
  // Given: a tampered font license mapping that references an ISO PDF
  const scenario = await createScenario();
  const isoPath = join(scenario.bundle, "THIRD_PARTY/fonts/ISO-IEC-999.pdf");
  await writeFile(isoPath, "%PDF-1.7 fixture normative text\n", "utf8");
  const source = await readFile(scenario.manifest, "utf8");
  await writeFile(scenario.manifest, source.replace("THIRD_PARTY/fonts/Bravura-OFL.txt", "THIRD_PARTY/fonts/ISO-IEC-999.pdf"), "utf8");

  // When: generation inspects the referenced compliance inputs
  const result = runGenerator(scenario);

  // Then: normative PDF bundling is explicitly prohibited
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ISO normative PDF content is prohibited/);
  await rm(scenario.root, { recursive: true, force: true });
});

test("blocks a source asset whose bytes no longer match the pinned source manifest", async () => {
  // Given: the pinned source archive is modified after its manifest was written
  const scenario = await createScenario();
  await writeFile(join(scenario.bundle, "THIRD_PARTY/sources/audiveris-9e1e55cd2746037d059345881c53e6a6754bffbd.tar.gz"), "tampered\n", "utf8");

  // When: source-release assets are collected
  const result = runGenerator(scenario);

  // Then: generation fails on identity rather than publishing the altered archive
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Audiveris.*source asset SHA-256 mismatch/);
  await rm(scenario.root, { recursive: true, force: true });
});
