import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const requiredArtifacts = [
  "THIRD_PARTY_NOTICES.md",
  "bom.cdx.json",
  "SOURCE_MANIFEST.json"
];

test("npm package manifest includes concrete compliance artifacts", async () => {
  // Given: the package manifest and its package-root compliance artifacts.
  const packageMetadata = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const artifacts = await Promise.all(requiredArtifacts.map(async (path) => [path, await readFile(resolve(root, path), "utf8")]));

  // When: the publish allowlist is checked against the concrete package artifacts.

  // Then: every required artifact is both present and explicitly included in npm pack.
  for (const [path, content] of artifacts) {
    assert.ok(content.trim(), `${path} must be non-empty`);
    assert.ok(packageMetadata.files.includes(path), `${path} must be included by package.json files`);
  }
});

test("package compliance metadata names the current package and bundled runtime sources", async () => {
  // Given: package metadata plus the generated compliance documents that npm will ship.
  const packageMetadata = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const bom = JSON.parse(await readFile(resolve(root, "bom.cdx.json"), "utf8"));
  const sources = JSON.parse(await readFile(resolve(root, "SOURCE_MANIFEST.json"), "utf8"));

  // When: their independent, machine-readable identifiers are inspected.

  // Then: the SBOM names this package version and source provenance names both pinned runtimes.
  assert.equal(bom.bomFormat, "CycloneDX");
  assert.equal(bom.specVersion, "1.7");
  assert.equal(bom.metadata.component.name, packageMetadata.name);
  assert.equal(bom.metadata.component.version, packageMetadata.version);
  assert.deepEqual(sources.sources.map((source) => source.name).sort(), ["Audiveris", "MuseScore"]);
});
