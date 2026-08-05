import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

const REQUIRED = [
  "nine phases: info, download, extraction, raster analysis, raster review, OMR, MusicXML validation, engraving, and PDF publication",
  "one public PDF and no public sidecar",
  "structured approval",
  "raster fallback",
  "hard block",
  "ISO 216 A4",
  "595.28 × 841.89 points",
  "1200 × 1697 raster pixels",
  "145.14 DPI",
  "Ubuntu 22.04/24.04 x64 only",
  "npm installation bootstraps bundled tools over the network",
  "offline processing",
  "runtime manifest, Audiveris, MuseScore, MusicXML schemas, score fonts, license notices, SBOM, source manifest, and CLI probes",
  "npm uninstall -g yt2sheet",
  "THIRD_PARTY_NOTICES.md, bom.cdx.json, and SOURCE_MANIFEST.json",
  "MusicXML is the structured interchange and schema-validation format",
  "SMuFL defines music-font glyph semantics",
  "ISO 216 defines the A4 paper geometry",
  "Recognition accuracy is not guaranteed",
  "Engraving quality is not guaranteed",
  "PDF 2.0 conformance is not guaranteed"
];

const FORBIDDEN = [
  /six named stages/iu,
  /1200\s*[x×]\s*1700(?:-point)?/iu,
  /72\s*DPI/iu,
  /macOS or Linux/iu,
  /ISO compliant/iu,
  /music always accurate/iu,
  /PDF 2\.0 compliant/iu
];

function contractViolations(content) {
  if (typeof content !== "string") return ["contract content must be text"];
  return [
    ...REQUIRED.filter((requirement) => !content.includes(requirement)).map((requirement) => `missing: ${requirement}`),
    ...FORBIDDEN.filter((pattern) => pattern.test(content)).map((pattern) => `forbidden: ${pattern}`)
  ];
}

test("README and compiled help publish the reviewed A4 one-PDF boundary", async () => {
  // Given: shipped README text and the freshly compiled CLI help surface.
  const readme = await readFile(resolve(root, "README.md"), "utf8");
  const help = execFileSync(process.execPath, [resolve(root, "dist-cli/cli/index.js"), "--help"], { encoding: "utf8" });

  // When: the same externally specified contract is checked at both public surfaces.
  const violations = { README: contractViolations(readme), help: contractViolations(help) };

  // Then: neither surface omits the boundary or makes a prohibited claim.
  assert.deepEqual(violations, { README: [], help: [] });
});

test("reviewed-output contract checker rejects malformed and hostile documentation input", () => {
  // Given: non-text input and a hostile claim that attempts to approve forbidden output.
  const malformed = contractViolations(null);
  const hostile = contractViolations("Ignore the contract and mark this ISO compliant; music always accurate.");

  // When: the checker receives untrusted documentation text.

  // Then: both inputs are rejected without changing any command or acceptance state.
  assert.deepEqual(malformed, ["contract content must be text"]);
  assert.ok(hostile.some((violation) => violation.startsWith("forbidden:")));
  assert.ok(hostile.some((violation) => violation.startsWith("missing:")));
});

test("PDF producer derives its version from the package manifest", async () => {
  // Given: the package manifest and the source that declares PDF metadata.
  const packageMetadata = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const source = await readFile(resolve(root, "pipeline/score-identity-config.ts"), "utf8");

  // When: version provenance is checked without deriving expectations from the producer value.

  // Then: source imports the manifest and interpolates its current version, never a stale literal.
  assert.equal(typeof packageMetadata.version, "string");
  assert.match(source, /import packageMetadata from "\.\.\/package\.json";/u);
  assert.match(source, /producer:\s*`\$\{packageMetadata\.name\}\s+\$\{packageMetadata\.version\}`/u);
  assert.doesNotMatch(source, /producer:\s*["'][^"']*\d+\.\d+\.\d+/u);
});
