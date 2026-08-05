import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { stageBundleCompliance } from "../scripts/stage-bundle-compliance.mjs";

const fixtureRoot = resolve("tests/fixtures/third-party-compliance");

test("stages real production compliance artifacts into a release bundle", async () => {
  // Given: a release-shaped staged bundle with pinned offline compliance inputs.
  const root = await mkdtemp(join(tmpdir(), "yt2sheet-real-compliance-stage-"));
  const bundleRoot = join(root, "bundle");
  try {
    await cp(join(fixtureRoot, "bundle"), bundleRoot, { recursive: true });
    await rm(join(bundleRoot, "THIRD_PARTY"), { recursive: true, force: true });
    for (const path of [
      "THIRD_PARTY/licenses/Audiveris-LICENSE",
      "THIRD_PARTY/licenses/MuseScore-LICENSE.txt",
      "THIRD_PARTY/fonts/Bravura-OFL.txt",
      "THIRD_PARTY/fonts/Leland-LICENSE.txt",
      "THIRD_PARTY/sources/audiveris-9e1e55cd2746037d059345881c53e6a6754bffbd.tar.gz",
      "THIRD_PARTY/sources/musescore-7688c005ad963ba09ee715aae53dbc7e8c9d5ef8.tar.gz"
    ]) {
      await mkdir(join(bundleRoot, path, ".."), { recursive: true });
      await cp(join(fixtureRoot, "bundle", path), join(bundleRoot, path));
    }
    await mkdir(join(bundleRoot, "tools/audiveris/runtime/legal/java.base"), { recursive: true });
    await writeFile(join(bundleRoot, "tools/audiveris/runtime/legal/java.base/LICENSE"), "JRE license notice fixture\n", "utf8");
    await mkdir(join(bundleRoot, "tools/musescore/lib"), { recursive: true });
    await writeFile(join(bundleRoot, "tools/musescore/lib/NOTICE"), "native library notice fixture\n", "utf8");

    // When: the release staging adapter invokes the real production generator.
    await stageBundleCompliance({
      generatorPath: resolve("scripts/generate-third-party-compliance.mjs"),
      runtimeManifestPath: resolve("scripts/score-runtime-manifest.json"),
      packageLockPath: resolve("package-lock.json"),
      platformId: "macos-14-arm64",
      bundleRoot,
      offline: true
    });

    // Then: the staged bundle exposes the complete validated compliance root.
    assert.deepEqual((await readdir(bundleRoot)).filter((name) => [
      "COMPLIANCE_SUMMARY.json", "SOURCE_MANIFEST.json", "THIRD_PARTY_NOTICES.md", "bom.cdx.json"
    ].includes(name)).sort(), ["COMPLIANCE_SUMMARY.json", "SOURCE_MANIFEST.json", "THIRD_PARTY_NOTICES.md", "bom.cdx.json"]);
    const summary = JSON.parse(await readFile(join(bundleRoot, "COMPLIANCE_SUMMARY.json"), "utf8"));
    assert.equal(summary.componentCount, 12);
    assert.equal(summary.directPackageCount, 8);
    const bom = JSON.parse(await readFile(join(bundleRoot, "bom.cdx.json"), "utf8"));
    assert.equal(bom.specVersion, "1.7");
    assert.equal(bom.components.length, 12);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
