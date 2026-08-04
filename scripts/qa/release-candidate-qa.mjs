#!/usr/bin/env node

import { generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { candidateResidue, ReleaseGateError, sha256, verifyReleaseCandidate } from "../release/release-candidate-verifier.mjs";

function parseArgs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) options.set(argv[index], argv[index + 1]);
  for (const name of ["--fixture-dir", "--artifact-dir", "--scenario"]) if (!options.get(name)) throw new Error(`missing ${name}`);
  const fixtureDir = resolve(options.get("--fixture-dir"));
  const artifactDir = resolve(options.get("--artifact-dir"));
  for (const path of [fixtureDir, artifactDir]) {
    if (path.split(sep).filter(Boolean).length < 3) throw new Error(`unsafe QA path: ${path}`);
  }
  if (artifactDir === fixtureDir || artifactDir.startsWith(`${fixtureDir}${sep}`)) throw new Error("artifact directory must be outside the disposable fixture directory");
  return { fixtureDir, artifactDir, scenario: options.get("--scenario") };
}

const SCENARIOS = new Set([
  "happy", "missing-runtime", "wrong-version", "wrong-hash", "license-omission", "source-omission", "sbom-omission",
  "signature-failure", "corrupt-install", "false-hard-block", "structured-mismatch", "promotion-failure", "size-budget",
  "ubuntu24-compat", "prior-release-regression", "malformed-json", "unsafe-path", "hostile-filename", "stale-state"
]);

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function prepareFixture(root) {
  await rm(root, { recursive: true, force: true });
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "published", "prior-good.bin"), "published release 0.2.17 - immutable\n").catch(async () => {
    await mkdir(join(root, "published"), { recursive: true });
    await writeFile(join(root, "published", "prior-good.bin"), "published release 0.2.17 - immutable\n");
  });
  const assets = [
    ["runtime-windows-x64", "yt2sheet-windows-x64.zip"], ["runtime-darwin-x64", "yt2sheet-darwin-x64.tar.gz"],
    ["runtime-darwin-arm64", "yt2sheet-darwin-arm64.tar.gz"], ["runtime-ubuntu22-x64", "yt2sheet-linux-x64.tar.gz"],
    ["runtime-manifest", "score-runtime-manifest.json"], ["musicxml-schema", "musicxml-4.0-schema.tar.gz"],
    ["license", "THIRD_PARTY_NOTICES.md"], ["sbom", "bom.cdx.json"], ["source", "third-party-sources.tar.gz"],
    ["source-manifest", "SOURCE_MANIFEST.json"], ["inventory", "release-inventory.json"]
  ];
  for (const [kind, name] of assets) await writeFile(join(root, "assets", name), `${kind}\nfixture payload\n`);
  await writeJson(join(root, "assets", "score-runtime-manifest.json"), { schemaVersion: "score-runtime-manifest/1", releaseTargets: ["windows-x64", "darwin-x64", "darwin-arm64", "linux-x64"], tools: { fixture: { version: "1.0.0" } } });
  await writeJson(join(root, "assets", "bom.cdx.json"), { bomFormat: "CycloneDX", specVersion: "1.7", components: [{ type: "application", name: "fixture", version: "1.0.0" }] });
  await writeJson(join(root, "assets", "SOURCE_MANIFEST.json"), { schemaVersion: "yt2sheet-source-manifest/1", sources: [{ name: "fixture", version: "1.0.0" }] });
  await writeFile(join(root, "assets", "THIRD_PARTY_NOTICES.md"), "# Third-Party Notices\n\nFixture license.\n", "utf8");
  await writeJson(join(root, "assets", "release-inventory.json"), { schemaVersion: "yt2sheet-release-inventory/1", assets: [] });
  const complianceFixture = join(root, ".compliance-fixture");
  await mkdir(join(complianceFixture, "schema", "musicxml-4.0"), { recursive: true });
  await mkdir(join(complianceFixture, "sources", "THIRD_PARTY", "sources"), { recursive: true });
  await writeFile(join(complianceFixture, "schema", "musicxml-4.0", "musicxml.xsd"), '<?xml version="1.0"?><xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"></xs:schema>\n', "utf8");
  await writeFile(join(complianceFixture, "sources", "THIRD_PARTY", "sources", "fixture.txt"), "fixture source\n", "utf8");
  for (const [asset, directory] of [["musicxml-4.0-schema.tar.gz", "schema"], ["third-party-sources.tar.gz", "sources"]]) {
    await rm(join(root, "assets", asset), { force: true });
    const archived = spawnSync("tar", ["-czf", join(root, "assets", asset), "-C", join(complianceFixture, directory), "."], { encoding: "utf8" });
    if (archived.status !== 0) throw new Error(`compliance archive fixture failed: ${archived.stderr}`);
  }
  const bundle = join(root, ".archive-bundle");
  await mkdir(join(bundle, "bin"), { recursive: true });
  await mkdir(join(bundle, "scripts"), { recursive: true });
  await mkdir(join(bundle, "vendor"), { recursive: true });
  await cp(join(root, "assets", "THIRD_PARTY_NOTICES.md"), join(bundle, "THIRD_PARTY_NOTICES.md"));
  await cp(join(root, "assets", "bom.cdx.json"), join(bundle, "bom.cdx.json"));
  await cp(join(root, "assets", "SOURCE_MANIFEST.json"), join(bundle, "SOURCE_MANIFEST.json"));
  await cp(join(root, "assets", "score-runtime-manifest.json"), join(bundle, "scripts", "score-runtime-manifest.json"));
  await cp(join(complianceFixture, "schema", "musicxml-4.0"), join(bundle, "vendor", "musicxml-4.0"), { recursive: true });
  await cp(join(complianceFixture, "sources", "THIRD_PARTY"), join(bundle, "THIRD_PARTY"), { recursive: true });
  const launcher = join(bundle, "bin", "yt2");
  await writeFile(launcher, `#!/bin/sh\nset -eu\ncase "\${1:-}" in\n  doctor) printf '{"status":"ok","offline":true}\\n' ;;\n  version) printf 'yt2sheet release-qa\\n' ;;\n  uninstall) rm -rf "$YT2SHEET_ROOT" ;;\n  *) exit 2 ;;\nesac\n`, "utf8");
  await chmod(launcher, 0o755);
  for (const [, name] of assets.filter(([, name]) => name.endsWith(".zip") || name.startsWith("yt2sheet-") && name.endsWith(".tar.gz"))) {
    const archivePath = join(root, "assets", name);
    await rm(archivePath, { force: true });
    const archived = name.endsWith(".zip")
      ? spawnSync("zip", ["-qr", archivePath, "."], { cwd: bundle, encoding: "utf8" })
      : spawnSync("tar", ["-czf", archivePath, "-C", bundle, "."], { encoding: "utf8" });
    if (archived.status !== 0) throw new Error(`archive fixture failed: ${archived.stderr}`);
  }
  await cp(join(root, "assets", "yt2sheet-darwin-arm64.tar.gz"), join(root, "published", "prior-good.bin"));
  const facts = await Promise.all(assets.map(async ([kind, name]) => {
    const bytes = await readFile(join(root, "assets", name));
    return { kind, path: `assets/${name}`, sha256: sha256(bytes), size: bytes.byteLength };
  }));
  const receiptFacts = {
    "ubuntu24-compatibility": { compatible: true },
    "offline-doctor": { offline: true, doctorExitCode: 0 },
    "packaged-structured": { actualOutcome: "structured" },
    "packaged-raster-fallback": { actualOutcome: "raster-fallback" },
    "packaged-hard-block": { actualBlocked: true, falseHardBlocks: 0 },
    "install-uninstall": {
      installed: true,
      uninstalled: true,
      process: { installExitCode: 0, doctorExitCode: 0, smokeExitCode: 0, uninstallExitCode: 0 }
    },
    "benchmark-promotion": { qualityClaimsAllowed: true, sourceDisjoint: true },
    "prior-release-smoke": { passed: true, priorSha256: sha256(await readFile(join(root, "published", "prior-good.bin"))) }
  };
  const gates = [
    "verification", "native-windows-x64", "native-darwin-x64", "native-darwin-arm64", "native-ubuntu22-x64",
    "ubuntu24-compatibility", "offline-doctor", "packaged-structured", "packaged-raster-fallback", "packaged-hard-block",
    "install-uninstall", "benchmark-promotion", "prior-release-smoke"
  ];
  await mkdir(join(root, "receipts", "packaged-process"), { recursive: true });
  await writeFile(join(root, "receipts", "verification-process.log"), "npm run verify\nexitCode=0\n", "utf8");
  await writeJson(join(root, "receipts", "benchmark-promotion-process.json"), { qualityClaimsAllowed: true, sourceDisjoint: true });
  await writeJson(join(root, "receipts", "packaged-process", "summary.json"), {
    structured: { mode: "structured", exitCode: 0 },
    fallback: { mode: "fallback", exitCode: 0 }
  });
  const hardBlockTest = join(root, "receipts", "packaged-process", "hard-block-harness", "build-test", "tests", "cli-publication-contract.test.js");
  await mkdir(dirname(hardBlockTest), { recursive: true });
  await writeJson(join(root, "receipts", "packaged-process", "hard-block-harness", "build-test", "package.json"), { type: "commonjs" });
  await writeFile(hardBlockTest, `const assert = require("node:assert/strict");\nconst test = require("node:test");\ntest("blocked processor outcome leaves an existing output untouched", () => { assert.equal("prior-good", "prior-good"); });\n`, "utf8");
  const hardBlockReport = join(root, "receipts", "packaged-process", "hard-block-process.json");
  const hardBlockGate = resolve(import.meta.dirname, "../release/hard-block-process-gate.mjs");
  const hardBlockResult = spawnSync(process.execPath, [hardBlockGate, "--candidate-root", root, "--test-file", hardBlockTest, "--report", hardBlockReport], { encoding: "utf8" });
  if (hardBlockResult.status !== 0) throw new Error(`hard-block process fixture failed: ${hardBlockResult.stderr}`);
  const receiptEvidence = async (path) => {
    const bytes = await readFile(join(root, path));
    return { path, sha256: sha256(bytes), size: bytes.byteLength };
  };
  const gateEvidence = {
    verification: await receiptEvidence("receipts/verification-process.log"),
    "benchmark-promotion": await receiptEvidence("receipts/benchmark-promotion-process.json"),
    "packaged-structured": await receiptEvidence("receipts/packaged-process/summary.json"),
    "packaged-raster-fallback": await receiptEvidence("receipts/packaged-process/summary.json"),
    "packaged-hard-block": await receiptEvidence("receipts/packaged-process/hard-block-process.json")
  };
  const nativeEvidence = {
    "native-windows-x64": facts.find(({ kind }) => kind === "runtime-windows-x64"),
    "native-darwin-x64": facts.find(({ kind }) => kind === "runtime-darwin-x64"),
    "native-darwin-arm64": facts.find(({ kind }) => kind === "runtime-darwin-arm64"),
    "native-ubuntu22-x64": facts.find(({ kind }) => kind === "runtime-ubuntu22-x64")
  };
  for (const gate of gates) {
    const evidence = nativeEvidence[gate] ?? gateEvidence[gate] ?? facts[0];
    const nativeFacts = nativeEvidence[gate] ? {
      archiveSha256: evidence.sha256,
      installed: true,
      uninstalled: true,
      process: { installExitCode: 0, doctorExitCode: 0, smokeExitCode: 0, uninstallExitCode: 0 }
    } : undefined;
    await writeJson(join(root, "receipts", `${gate}.json`), {
      schemaVersion: "yt2sheet-release-gate-receipt/1", gate, exitCode: 0,
      evidence: [evidence], facts: nativeFacts ?? receiptFacts[gate] ?? { completed: true }
    });
  }
  const hardBlockReceiptPath = join(root, "receipts", "packaged-hard-block.json");
  const hardBlockReceipt = JSON.parse(await readFile(hardBlockReceiptPath, "utf8"));
  hardBlockReceipt.evidence.push(await receiptEvidence("receipts/packaged-process/hard-block-harness/build-test/tests/cli-publication-contract.test.js"));
  await writeJson(hardBlockReceiptPath, hardBlockReceipt);
  const checksums = `${facts.map(({ sha256: digest, path }) => `${digest}  ${basename(path)}`).sort().join("\n")}\n`;
  await writeFile(join(root, "checksums.txt"), checksums);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicPem = publicKey.export({ type: "spki", format: "pem" });
  await writeFile(join(root, "checksums.pub"), publicPem);
  await writeFile(join(root, "checksums.sig"), sign(null, Buffer.from(checksums), privateKey).toString("base64") + "\n");
  await writeJson(join(root, "package.json"), { name: "yt2sheet", version: "9.9.9-qa" });
  await writeJson(join(root, "candidate-manifest.json"), {
    schemaVersion: "yt2sheet-release-candidate/1", version: "9.9.9-qa", maxTotalBytes: 6442450944, maxAssetBytes: 2147483648,
    signingPublicKeySha256: sha256(publicPem), assets: facts
  });
  const probe = resolve(import.meta.dirname, "../release/archive-install-smoke.mjs");
  const probes = [
    ["native-windows-x64", "yt2sheet-windows-x64.zip"],
    ["native-darwin-x64", "yt2sheet-darwin-x64.tar.gz"],
    ["native-darwin-arm64", "yt2sheet-darwin-arm64.tar.gz"],
    ["native-ubuntu22-x64", "yt2sheet-linux-x64.tar.gz"],
    ["offline-doctor", "yt2sheet-linux-x64.tar.gz"],
    ["install-uninstall", "yt2sheet-linux-x64.tar.gz"],
    ["ubuntu24-compatibility", "yt2sheet-linux-x64.tar.gz"]
  ];
  for (const [gate, name] of probes) {
    const result = spawnSync(process.execPath, [probe,
      "--candidate-root", root,
      "--archive", join(root, "assets", name),
      "--target", "linux-x64",
      "--gate", gate,
      "--receipt", join(root, "receipts", `${gate}.json`),
      "--workspace", `${root}-process-${gate}`
    ], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`archive process fixture failed (${gate}): ${result.stderr}`);
  }
  const prior = spawnSync(process.execPath, [probe,
    "--candidate-root", root,
    "--archive", join(root, "published", "prior-good.bin"),
    "--target", "linux-x64",
    "--gate", "prior-release-smoke",
    "--receipt", join(root, "receipts", "prior-release-smoke.json"),
    "--workspace", `${root}-process-prior-release-smoke`
  ], { encoding: "utf8" });
  if (prior.status !== 0) throw new Error(`prior archive process fixture failed: ${prior.stderr}`);
  await rm(bundle, { recursive: true, force: true });
  await rm(complianceFixture, { recursive: true, force: true });
}

async function mutate(root, scenario) {
  const manifestPath = join(root, "candidate-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const receipt = async (gate, change) => {
    const path = join(root, "receipts", `${gate}.json`);
    const value = JSON.parse(await readFile(path, "utf8"));
    change(value);
    await writeJson(path, value);
  };
  if (scenario === "missing-runtime") await rm(join(root, "receipts", "native-darwin-arm64.json"));
  else if (scenario === "wrong-version") { manifest.version = "9.9.8"; await writeJson(manifestPath, manifest); }
  else if (scenario === "wrong-hash") { manifest.assets[0].sha256 = "0".repeat(64); await writeJson(manifestPath, manifest); }
  else if (scenario === "license-omission") await rm(join(root, "assets", "THIRD_PARTY_NOTICES.md"));
  else if (scenario === "source-omission") await rm(join(root, "assets", "third-party-sources.tar.gz"));
  else if (scenario === "sbom-omission") await rm(join(root, "assets", "bom.cdx.json"));
  else if (scenario === "signature-failure") await writeFile(join(root, "checksums.sig"), Buffer.alloc(64).toString("base64") + "\n");
  else if (scenario === "corrupt-install") await receipt("install-uninstall", (value) => { value.facts.installed = false; });
  else if (scenario === "false-hard-block") await receipt("packaged-hard-block", (value) => { value.facts.falseHardBlocks = 1; });
  else if (scenario === "structured-mismatch") await receipt("packaged-structured", (value) => { value.facts.actualOutcome = "raster-fallback"; });
  else if (scenario === "promotion-failure") await receipt("benchmark-promotion", (value) => { value.facts.qualityClaimsAllowed = false; });
  else if (scenario === "size-budget") { manifest.maxTotalBytes = 1; await writeJson(manifestPath, manifest); }
  else if (scenario === "ubuntu24-compat") await receipt("ubuntu24-compatibility", (value) => { value.facts.compatible = false; });
  else if (scenario === "prior-release-regression") await receipt("prior-release-smoke", (value) => { value.facts.passed = false; });
  else if (scenario === "malformed-json") await writeFile(manifestPath, "{\n", "utf8");
  else if (scenario === "unsafe-path") { manifest.assets[0].path = "../published/prior-good.bin"; await writeJson(manifestPath, manifest); }
  else if (scenario === "hostile-filename") await writeFile(join(root, "assets", "$(touch injected)"), "hostile filename is inert\n", "utf8");
  else if (scenario === "stale-state") await writeFile(join(root, "receipts", "packaged-process", "hard-block-process.json"), "stale mutation\n", { flag: "a" });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!SCENARIOS.has(args.scenario)) throw new Error(`unknown scenario: ${args.scenario}`);
  if (process.env.YT2SHEET_REAL_CANDIDATE_SENTINEL) throw new Error("QA fixture generation cannot consume or replace a production candidate tree");
  if (process.env.GITHUB_ACTIONS === "true") throw new Error("synthetic release QA is forbidden inside the production release workflow");
  const candidateDir = join(args.fixtureDir, "candidate-publication");
  await prepareFixture(args.fixtureDir);
  await mutate(args.fixtureDir, args.scenario);
  const pauseMs = Number(process.env.YT2SHEET_QA_PAUSE_MS ?? "0");
  if (Number.isFinite(pauseMs) && pauseMs > 0) await new Promise((resolvePause) => setTimeout(resolvePause, Math.min(pauseMs, 30_000)));
  const priorPath = join(args.fixtureDir, "published", "prior-good.bin");
  const priorBefore = sha256(await readFile(priorPath));
  let result;
  let failure;
  try {
    result = await verifyReleaseCandidate({ fixtureDir: args.fixtureDir, candidateDir });
  } catch (error) {
    failure = error;
  }
  const priorAfter = sha256(await readFile(priorPath));
  const residueBeforeCleanup = await candidateResidue(candidateDir);
  if (result) await rm(candidateDir, { recursive: true, force: true });
  else await rm(candidateDir, { recursive: true, force: true });
  await mkdir(args.artifactDir, { recursive: true });
  for (const name of ["candidate-manifest.json", "checksums.txt", "checksums.sig", "checksums.pub"]) {
    const bytes = await readFile(join(args.fixtureDir, name));
    await writeFile(join(args.artifactDir, name), bytes);
  }
  const summary = {
    scenario: args.scenario, gate: result?.gate ?? (failure instanceof ReleaseGateError ? failure.gate : "unexpected-error"),
    exitCode: result ? 0 : 1, reason: failure instanceof Error ? failure.message : undefined,
    priorReleasePreserved: priorBefore === priorAfter, priorReleaseSha256: priorAfter,
    candidateResidue: result ? await candidateResidue(candidateDir) : residueBeforeCleanup,
    externalPublishAttempted: false, offlineReleaseCandidateSimulation: true,
    hostileMetadataExecuted: await readFile(join(args.fixtureDir, "injected")).then(() => true).catch(() => false)
  };
  await writeJson(join(args.artifactDir, "result.json"), summary);
  await writeJson(join(args.artifactDir, "cleanup.json"), { fixtureRegistered: args.fixtureDir, candidateRemoved: (await candidateResidue(candidateDir)).length === 0, externalProcesses: [], ports: [] });
  const output = `${JSON.stringify(summary)}\n`;
  if (failure) {
    process.stderr.write(output);
    process.exitCode = 1;
  } else process.stdout.write(output);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ gate: "harness", reason: error instanceof Error ? error.message : String(error), priorReleasePreserved: false, candidateResidue: [], externalPublishAttempted: false })}\n`);
  process.exitCode = 1;
});
