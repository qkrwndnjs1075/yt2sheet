import { createHash, verify as verifySignature } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { verifyArchiveDerivedCompliance } from "./archive-derived-compliance.mjs";
import { verifyHardBlockProcessReport } from "./hard-block-process-gate.mjs";

export class ReleaseGateError extends Error {
  constructor(gate, detail) {
    super(`${gate}: ${detail}`);
    this.name = "ReleaseGateError";
    this.gate = gate;
  }
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readJson(path, gate) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new ReleaseGateError(gate, error instanceof SyntaxError ? `malformed JSON: ${basename(path)}` : `missing artifact: ${basename(path)}`);
  }
}

async function fileFact(root, entry, gate) {
  const path = resolve(root, entry.path);
  if (!path.startsWith(`${resolve(root)}${sep}`)) throw new ReleaseGateError(gate, `unsafe inventory path: ${entry.path}`);
  let bytes;
  try {
    bytes = await readFile(path);
  } catch {
    throw new ReleaseGateError(gate, `missing artifact: ${entry.path}`);
  }
  const digest = sha256(bytes);
  if (digest !== entry.sha256) throw new ReleaseGateError(gate, `SHA-256 mismatch: ${entry.path}`);
  return { path: entry.path, sha256: digest, size: bytes.byteLength };
}

async function verifyReceipt(root, gate) {
  let receipt;
  try {
    receipt = await readJson(join(root, "receipts", `${gate}.json`), gate);
  } catch (error) {
    if (gate.startsWith("native-") && error instanceof ReleaseGateError) {
      throw new ReleaseGateError("native-runtime-receipts", `missing or invalid ${gate} receipt`);
    }
    throw error;
  }
  if (receipt.schemaVersion !== "yt2sheet-release-gate-receipt/1" || receipt.gate !== gate || receipt.exitCode !== 0) {
    throw new ReleaseGateError(gate, "receipt does not prove a zero exit code for this gate");
  }
  if (!Array.isArray(receipt.evidence) || receipt.evidence.length === 0) throw new ReleaseGateError(gate, "receipt has no artifact evidence");
  for (const entry of receipt.evidence) await fileFact(root, entry, gate);
  return receipt;
}

const RECEIPT_GATES = Object.freeze([
  "verification", "native-windows-x64", "native-darwin-x64", "native-darwin-arm64", "native-ubuntu22-x64",
  "ubuntu24-compatibility", "offline-doctor", "packaged-structured", "packaged-raster-fallback",
  "packaged-hard-block", "install-uninstall", "benchmark-promotion", "prior-release-smoke"
]);

const NATIVE_ARCHIVES = Object.freeze({
  "native-windows-x64": "assets/yt2sheet-windows-x64.zip",
  "native-darwin-x64": "assets/yt2sheet-darwin-x64.tar.gz",
  "native-darwin-arm64": "assets/yt2sheet-darwin-arm64.tar.gz",
  "native-ubuntu22-x64": "assets/yt2sheet-linux-x64.tar.gz"
});

const REQUIRED_ASSET_KINDS = Object.freeze([
  "runtime-windows-x64", "runtime-darwin-x64", "runtime-darwin-arm64", "runtime-ubuntu22-x64",
  "runtime-manifest", "musicxml-schema", "license", "sbom", "source", "inventory"
]);

const MAX_ASSET_BYTES = 2147483648;
const MAX_TOTAL_BYTES = 6442450944;

function requireReceiptFact(receipts, gate, field, expected) {
  if (receipts[gate]?.facts?.[field] !== expected) throw new ReleaseGateError(gate, `${field} must equal ${JSON.stringify(expected)}`);
}

function evidenceFact(receipt, path) {
  return receipt.evidence.find((entry) => entry.path === path);
}

function requireProcess(receipt, gate, fields) {
  const process = receipt.facts?.process;
  if (!process || typeof process !== "object") throw new ReleaseGateError(gate, "process-derived exit evidence is missing");
  for (const field of fields) {
    if (process[field] !== 0) throw new ReleaseGateError(gate, `${field} must equal 0`);
  }
}

async function processReport(root, receipt, gate) {
  const evidence = receipt.evidence.find((entry) => entry.path.endsWith("-archive-process.json"));
  if (!evidence) throw new ReleaseGateError(gate, "archive process report evidence is missing");
  const report = await readJson(join(root, evidence.path), gate);
  if (report.schemaVersion !== "yt2sheet-archive-process/1" || report.installed !== true || report.uninstalled !== true) {
    throw new ReleaseGateError(gate, "archive process report does not prove install and uninstall");
  }
  for (const field of ["extract", "doctor", "smoke", "uninstall"]) {
    if (report.observations?.[field]?.exitCode !== 0) throw new ReleaseGateError(gate, `${field} process did not exit zero`);
  }
  return report;
}

async function jsonEvidence(root, receipt, gate, suffix) {
  const evidence = receipt.evidence.find((entry) => entry.path.endsWith(suffix));
  if (!evidence) throw new ReleaseGateError(gate, `process evidence is missing: ${suffix}`);
  return readJson(join(root, evidence.path), gate);
}

async function verifyProcessDerivedOutcomes(root, receipts) {
  const verification = receipts.verification.evidence.find((entry) => entry.path.endsWith("verification-process.log"));
  if (!verification || verification.size < 1) throw new ReleaseGateError("verification", "npm run verify process log is missing");
  const benchmark = await jsonEvidence(root, receipts["benchmark-promotion"], "benchmark-promotion", "benchmark-promotion-process.json");
  if (benchmark.qualityClaimsAllowed !== true || benchmark.sourceDisjoint !== true) throw new ReleaseGateError("benchmark-promotion", "benchmark process report did not authorize promotion");
  const structured = await jsonEvidence(root, receipts["packaged-structured"], "packaged-structured", "summary.json");
  if (structured.structured?.mode !== "structured" || structured.structured?.exitCode !== 0) throw new ReleaseGateError("packaged-structured", "packaged structured process mismatch");
  const fallback = await jsonEvidence(root, receipts["packaged-raster-fallback"], "packaged-raster-fallback", "summary.json");
  if (fallback.fallback?.mode !== "fallback" || fallback.fallback?.exitCode !== 0) throw new ReleaseGateError("packaged-raster-fallback", "packaged fallback process mismatch");
  await verifyHardBlockProcessReport({
    candidateRoot: root,
    receipt: receipts["packaged-hard-block"],
    fail: (detail) => { throw new ReleaseGateError("packaged-hard-block", detail); }
  });
}

async function verifyNativeReceipts(root, receipts) {
  for (const [gate, archivePath] of Object.entries(NATIVE_ARCHIVES)) {
    const receipt = receipts[gate];
    const archive = evidenceFact(receipt, archivePath);
    if (!archive || receipt.facts?.archiveSha256 !== archive.sha256) {
      throw new ReleaseGateError("native-runtime-receipts", `${gate} is not byte-linked to ${archivePath}`);
    }
    requireProcess(receipt, gate, ["installExitCode", "doctorExitCode", "smokeExitCode", "uninstallExitCode"]);
    const report = await processReport(root, receipt, gate);
    if (report.archiveSha256 !== archive.sha256) throw new ReleaseGateError(gate, "process report archive hash differs from downloaded archive");
    if (receipt.facts?.installed !== true || receipt.facts?.uninstalled !== true) {
      throw new ReleaseGateError("install-uninstall", `${gate} did not install and uninstall its archive`);
    }
  }
}

async function verifyInventory(root, manifest) {
  if (!Array.isArray(manifest.assets)) throw new ReleaseGateError("compliance-inventory", "candidate assets are missing");
  const kinds = manifest.assets.map(({ kind }) => kind);
  for (const kind of REQUIRED_ASSET_KINDS) {
    if (kinds.filter((candidate) => candidate === kind).length !== 1) throw new ReleaseGateError("compliance-inventory", `expected exactly one ${kind} asset`);
  }
  const declaredPaths = manifest.assets.map(({ path }) => path).sort();
  const actualPaths = (await readdir(join(root, "assets"))).map((name) => `assets/${name}`).sort();
  if (JSON.stringify(declaredPaths) !== JSON.stringify(actualPaths)) throw new ReleaseGateError("compliance-inventory", "declared and actual asset inventories differ");
  return Promise.all(manifest.assets.map((entry) => fileFact(root, entry, "artifact-integrity")));
}

async function verifyChecksumsAndSignature(root, facts, manifest) {
  const checksumBytes = await readFile(join(root, "checksums.txt")).catch(() => { throw new ReleaseGateError("artifact-integrity", "checksums.txt is missing"); });
  const expected = `${facts.map(({ sha256: digest, path }) => `${digest}  ${basename(path)}`).sort().join("\n")}\n`;
  if (checksumBytes.toString("utf8") !== expected) throw new ReleaseGateError("artifact-integrity", "checksums.txt does not exactly match candidate assets");
  const signature = await readFile(join(root, "checksums.sig"), "utf8").catch(() => { throw new ReleaseGateError("candidate-signature", "checksums.sig is missing"); });
  const publicKey = await readFile(join(root, "checksums.pub"), "utf8").catch(() => { throw new ReleaseGateError("candidate-signature", "checksums.pub is missing"); });
  if (sha256(publicKey) !== manifest.signingPublicKeySha256) throw new ReleaseGateError("candidate-signature", "signing key hash mismatch");
  if (!verifySignature(null, checksumBytes, publicKey, Buffer.from(signature.trim(), "base64"))) throw new ReleaseGateError("candidate-signature", "invalid checksum signature");
}

async function verifyCompliance(root) {
  const runtime = await readJson(join(root, "assets", "score-runtime-manifest.json"), "compliance-inventory");
  if (runtime.schemaVersion !== "score-runtime-manifest/1" || !Array.isArray(runtime.releaseTargets) || typeof runtime.tools !== "object") {
    throw new ReleaseGateError("compliance-inventory", "runtime manifest is invalid");
  }
  const sbom = await readJson(join(root, "assets", "bom.cdx.json"), "compliance-inventory");
  if (sbom.bomFormat !== "CycloneDX" || !Array.isArray(sbom.components) || sbom.components.length === 0) {
    throw new ReleaseGateError("compliance-inventory", "SBOM is invalid or empty");
  }
  const sourceManifest = await readJson(join(root, "assets", "SOURCE_MANIFEST.json"), "compliance-inventory");
  if (sourceManifest.schemaVersion !== "yt2sheet-source-manifest/1" || !Array.isArray(sourceManifest.sources) || sourceManifest.sources.length === 0) {
    throw new ReleaseGateError("compliance-inventory", "source manifest is invalid or empty");
  }
  if (!(await readFile(join(root, "assets", "THIRD_PARTY_NOTICES.md"), "utf8")).trim()) throw new ReleaseGateError("compliance-inventory", "license notices are empty");
  const schema = spawnSync("tar", ["-xOf", join(root, "assets", "musicxml-4.0-schema.tar.gz"), "./musicxml-4.0/musicxml.xsd"], { encoding: "utf8", timeout: 30_000 });
  if (schema.status !== 0 || !/<xs:schema\b/u.test(schema.stdout)) throw new ReleaseGateError("compliance-inventory", "MusicXML schema archive is invalid");
  const sources = spawnSync("tar", ["-tzf", join(root, "assets", "third-party-sources.tar.gz")], { encoding: "utf8", timeout: 30_000 });
  const sourcePaths = sources.stdout.split(/\r?\n/u).filter(Boolean);
  if (sources.status !== 0 || sourcePaths.length === 0 || sourcePaths.some((path) => path.startsWith("/") || path.split("/").includes(".."))) {
    throw new ReleaseGateError("compliance-inventory", "source archive is empty or unsafe");
  }
}

export async function verifyReleaseCandidate({ fixtureDir, candidateDir }) {
  const root = resolve(fixtureDir);
  const output = resolve(candidateDir);
  const priorPath = join(root, "published", "prior-good.bin");
  const priorBefore = sha256(await readFile(priorPath));
  await rm(output, { recursive: true, force: true });
  try {
    const manifest = await readJson(join(root, "candidate-manifest.json"), "candidate-version");
    const packageMetadata = await readJson(join(root, "package.json"), "candidate-version");
    if (manifest.schemaVersion !== "yt2sheet-release-candidate/1" || manifest.version !== packageMetadata.version) {
      throw new ReleaseGateError("candidate-version", "candidate version differs from package version");
    }
    const receiptEntries = [];
    for (const gate of RECEIPT_GATES) receiptEntries.push([gate, await verifyReceipt(root, gate)]);
    const receipts = Object.fromEntries(receiptEntries);
    await verifyNativeReceipts(root, receipts);
    for (const gate of ["ubuntu24-compatibility", "offline-doctor", "install-uninstall", "prior-release-smoke"]) {
      await processReport(root, receipts[gate], gate);
    }
    await verifyProcessDerivedOutcomes(root, receipts);
    const facts = await verifyInventory(root, manifest);
    await verifyCompliance(root);
    await verifyArchiveDerivedCompliance(root).catch((error) => {
      if (error instanceof ReleaseGateError) throw error;
      throw new ReleaseGateError("archive-derived-compliance", error instanceof Error ? error.message.replace(/^archive-derived-compliance:\s*/u, "") : String(error));
    });
    await verifyChecksumsAndSignature(root, facts, manifest);
    if (manifest.maxAssetBytes !== MAX_ASSET_BYTES || !Number.isSafeInteger(manifest.maxTotalBytes) || manifest.maxTotalBytes < 1 || manifest.maxTotalBytes > MAX_TOTAL_BYTES) {
      throw new ReleaseGateError("size-budget", "candidate byte budgets exceed or bypass release policy");
    }
    if (facts.some((fact) => fact.size > manifest.maxAssetBytes)) throw new ReleaseGateError("size-budget", "candidate asset exceeds the declared byte budget");
    if (facts.reduce((total, fact) => total + fact.size, 0) > manifest.maxTotalBytes) throw new ReleaseGateError("size-budget", "candidate exceeds the declared byte budget");
    requireReceiptFact(receipts, "ubuntu24-compatibility", "compatible", true);
    requireReceiptFact(receipts, "offline-doctor", "offline", true);
    requireReceiptFact(receipts, "offline-doctor", "doctorExitCode", 0);
    requireReceiptFact(receipts, "packaged-structured", "actualOutcome", "structured");
    requireReceiptFact(receipts, "packaged-raster-fallback", "actualOutcome", "raster-fallback");
    requireReceiptFact(receipts, "packaged-hard-block", "actualBlocked", true);
    requireReceiptFact(receipts, "packaged-hard-block", "falseHardBlocks", 0);
    requireReceiptFact(receipts, "install-uninstall", "installed", true);
    requireReceiptFact(receipts, "install-uninstall", "uninstalled", true);
    requireProcess(receipts["install-uninstall"], "install-uninstall", ["installExitCode", "doctorExitCode", "smokeExitCode", "uninstallExitCode"]);
    requireReceiptFact(receipts, "benchmark-promotion", "qualityClaimsAllowed", true);
    requireReceiptFact(receipts, "benchmark-promotion", "sourceDisjoint", true);
    requireReceiptFact(receipts, "prior-release-smoke", "passed", true);
    if (receipts["prior-release-smoke"].facts.priorSha256 !== priorBefore) throw new ReleaseGateError("prior-release-smoke", "prior-good hash differs from the smoke receipt");
    await mkdir(dirname(output), { recursive: true });
    await mkdir(output);
    await writeFile(join(output, "publication-receipt.json"), `${JSON.stringify({ version: manifest.version, priorSha256: priorBefore, assetFacts: facts }, null, 2)}\n`);
    return { gate: "candidate-commit", version: manifest.version, assetFacts: facts, priorSha256: priorBefore };
  } finally {
    const priorAfter = sha256(await readFile(priorPath));
    if (priorAfter !== priorBefore) throw new ReleaseGateError("prior-release-preservation", "prior-good release bytes changed");
  }
}

export async function candidateResidue(candidateDir) {
  if (!existsSync(candidateDir)) return [];
  return readdir(candidateDir);
}
