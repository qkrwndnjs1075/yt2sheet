import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

const projectRoot = resolve(import.meta.dirname, "..");
const harness = resolve(projectRoot, "scripts/qa/release-candidate-qa.mjs");
const archiveSmoke = resolve(projectRoot, "scripts/release/archive-install-smoke.mjs");
const candidateAssembler = resolve(projectRoot, "scripts/release/assemble-release-candidate.mjs");
const candidateVerifier = new URL("../scripts/release/release-candidate-verifier.mjs", import.meta.url).href;
const syntheticQaEnvironment = { GITHUB_ACTIONS: "false", GITHUB_EVENT_NAME: "local" };

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function runVerifier(fixture, publication) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { verifyReleaseCandidate } from ${JSON.stringify(candidateVerifier)};
    await verifyReleaseCandidate({ fixtureDir: process.argv[1], candidateDir: process.argv[2] });
  `, fixture, publication], { cwd: projectRoot, encoding: "utf8" });
}

function runHarness(root, scenario = "happy", environment = {}) {
  return spawnSync(process.execPath, [harness, "--fixture-dir", `${root}/fixture`, "--artifact-dir", `${root}/evidence`, "--scenario", scenario], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, ...syntheticQaEnvironment, ...environment }
  });
}

test("release candidate simulation blocks every named rollback condition", () => {
  const root = mkdtempSync(`${tmpdir()}/yt2sheet-release-gates-`);
  try {
    const scenarios = [
      ["happy", 0, "candidate-commit"],
      ["missing-runtime", 1, "native-runtime-receipts"],
      ["wrong-version", 1, "candidate-version"],
      ["wrong-hash", 1, "artifact-integrity"],
      ["license-omission", 1, "compliance-inventory"],
      ["source-omission", 1, "compliance-inventory"],
      ["sbom-omission", 1, "compliance-inventory"],
      ["signature-failure", 1, "candidate-signature"],
      ["corrupt-install", 1, "install-uninstall"],
      ["false-hard-block", 1, "packaged-hard-block"],
      ["structured-mismatch", 1, "packaged-structured"],
      ["promotion-failure", 1, "benchmark-promotion"],
      ["size-budget", 1, "size-budget"],
      ["ubuntu24-compat", 1, "ubuntu24-compatibility"],
      ["prior-release-regression", 1, "prior-release-smoke"],
      ["malformed-json", 1, "candidate-version"],
      ["unsafe-path", 1, "compliance-inventory"],
      ["hostile-filename", 1, "compliance-inventory"],
      ["stale-state", 1, "packaged-hard-block"]
    ];
    for (const [scenario, expectedStatus, gate] of scenarios) {
      const result = spawnSync(process.execPath, [harness, "--fixture-dir", `${root}/${scenario}/fixture`, "--artifact-dir", `${root}/${scenario}/evidence`, "--scenario", scenario], {
        cwd: projectRoot,
        encoding: "utf8",
        env: { ...process.env, ...syntheticQaEnvironment }
      });
      assert.equal(result.status, expectedStatus, `${scenario}: ${result.stderr}`);
      const output = JSON.parse((expectedStatus === 0 ? result.stdout : result.stderr).trim().split("\n").at(-1));
      assert.equal(output.gate, gate, scenario);
      assert.equal(output.priorReleasePreserved, true, scenario);
      assert.deepEqual(output.candidateResidue, [], scenario);
      assert.equal(output.externalPublishAttempted, false, scenario);
      assert.equal(output.hostileMetadataExecuted, false, scenario);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate verifier rejects a native receipt that is not bound to its downloaded archive", () => {
  const root = mkdtempSync(`${tmpdir()}/yt2sheet-native-authority-`);
  try {
    assert.equal(runHarness(root).status, 0);
    const receiptPath = `${root}/fixture/receipts/native-darwin-arm64.json`;
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    const unrelatedReceipt = JSON.parse(readFileSync(`${root}/fixture/receipts/native-windows-x64.json`, "utf8"));
    receipt.evidence = unrelatedReceipt.evidence;
    receipt.facts.archiveSha256 = unrelatedReceipt.facts.archiveSha256;
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { verifyReleaseCandidate } from ${JSON.stringify(new URL("../scripts/release/release-candidate-verifier.mjs", import.meta.url).href)};
      await verifyReleaseCandidate({ fixtureDir: process.argv[1], candidateDir: process.argv[2] });
    `, `${root}/fixture`, `${root}/candidate`], { cwd: projectRoot, encoding: "utf8" });
    assert.notEqual(result.status, 0, "a native receipt linked to an unrelated asset must fail closed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("QA cannot replace a caller-provided candidate tree with a separately generated synthetic tree", () => {
  const root = mkdtempSync(`${tmpdir()}/yt2sheet-real-candidate-`);
  try {
    const fixture = `${root}/fixture`;
    writeFileSync(`${root}/sentinel`, "caller-owned-candidate\n");
    const result = runHarness(root, "happy", { YT2SHEET_REAL_CANDIDATE_SENTINEL: `${root}/sentinel` });
    assert.notEqual(result.status, 0, "the QA generator must never stand in for the production candidate verifier");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate verifier requires a process-derived archive install doctor smoke uninstall receipt", () => {
  const root = mkdtempSync(`${tmpdir()}/yt2sheet-install-authority-`);
  try {
    assert.equal(runHarness(root).status, 0);
    const receiptPath = `${root}/fixture/receipts/install-uninstall.json`;
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    delete receipt.facts.process;
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { verifyReleaseCandidate } from ${JSON.stringify(new URL("../scripts/release/release-candidate-verifier.mjs", import.meta.url).href)};
      await verifyReleaseCandidate({ fixtureDir: process.argv[1], candidateDir: process.argv[2] });
    `, `${root}/fixture`, `${root}/candidate`], { cwd: projectRoot, encoding: "utf8" });
    assert.notEqual(result.status, 0, "boolean install facts without process exit evidence must fail closed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow dispatch cannot substitute the synthetic happy fixture for prior-release regression", () => {
  const root = mkdtempSync(`${tmpdir()}/yt2sheet-dispatch-authority-`);
  try {
    const result = runHarness(root, "happy", { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch" });
    assert.notEqual(result.status, 0, "dispatch must fail closed unless a real prior published release was exercised");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("archive smoke installs, doctors, executes, and uninstalls the exact archive bytes", () => {
  const root = mkdtempSync(`${tmpdir()}/yt2sheet-archive-process-`);
  try {
    const candidate = `${root}/candidate`;
    const bundle = `${root}/bundle`;
    mkdirSync(`${candidate}/assets`, { recursive: true });
    mkdirSync(`${bundle}/bin`, { recursive: true });
    const launcher = `${bundle}/bin/yt2`;
    writeFileSync(launcher, `#!/bin/sh\nset -eu\ncase "\${1:-}" in\n  doctor) printf '{"status":"ok","offline":true}\\n' ;;\n  version) printf 'yt2sheet archive-fixture\\n' ;;\n  uninstall) rm -rf "$YT2SHEET_ROOT" ;;\n  *) exit 2 ;;\nesac\n`);
    chmodSync(launcher, 0o755);
    const archive = `${candidate}/assets/yt2sheet-darwin-arm64.tar.gz`;
    const archived = spawnSync("tar", ["-czf", archive, "-C", bundle, "."], { encoding: "utf8" });
    assert.equal(archived.status, 0, archived.stderr);
    const receipt = `${candidate}/receipts/native-darwin-arm64.json`;
    const workspace = `${root}/workspace`;
    const result = spawnSync(process.execPath, [archiveSmoke, "--candidate-root", candidate, "--archive", archive, "--target", "darwin-arm64", "--receipt", receipt, "--workspace", workspace], { cwd: projectRoot, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(readFileSync(receipt, "utf8"));
    assert.deepEqual(value.facts.process, { installExitCode: 0, doctorExitCode: 0, smokeExitCode: 0, uninstallExitCode: 0 });
    assert.equal(value.facts.installed, true);
    assert.equal(value.facts.uninstalled, true);
    assert.equal(value.evidence[0].path, "assets/yt2sheet-darwin-arm64.tar.gz");
    assert.equal(existsSync(workspace), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production assembler publishes flat checksums that a prior-release download verifies and smokes", () => {
  const root = mkdtempSync(`${tmpdir()}/yt2sheet-candidate-assembler-`);
  try {
    const prepared = runHarness(root);
    assert.equal(prepared.status, 0, prepared.stderr);
    const fixture = `${root}/fixture`;
    const publication = `${fixture}/release-assets`;
    const result = spawnSync(process.execPath, [candidateAssembler, "--candidate-root", fixture, "--package-json", `${fixture}/package.json`, "--publication-dir", publication], { cwd: projectRoot, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(`${publication}/publication-receipt.json`), true);
    assert.equal(existsSync(`${publication}/yt2sheet-linux-x64.tar.gz`), true);
    const inventory = JSON.parse(readFileSync(`${publication}/release-inventory.json`, "utf8"));
    assert.equal(inventory.assets.every(({ path }) => !path.includes("/") && existsSync(`${publication}/${path}`)), true,
      "published inventory paths must resolve within the flat release directory");
    const publishedChecksum = spawnSync("sha256sum", ["--check", "checksums.txt"], { cwd: publication, encoding: "utf8" });
    assert.equal(publishedChecksum.status, 0, publishedChecksum.stderr);

    const priorRelease = `${root}/prior-release`;
    mkdirSync(priorRelease);
    copyFileSync(`${publication}/checksums.txt`, `${priorRelease}/checksums.txt`);
    copyFileSync(`${publication}/yt2sheet-linux-x64.tar.gz`, `${priorRelease}/yt2sheet-linux-x64.tar.gz`);
    const downloadedChecksum = spawnSync("sh", ["-c", "grep 'yt2sheet-linux-x64.tar.gz' checksums.txt | sha256sum --check -"], { cwd: priorRelease, encoding: "utf8" });
    assert.equal(downloadedChecksum.status, 0, downloadedChecksum.stderr);
    const priorSmoke = spawnSync(process.execPath, [archiveSmoke,
      "--candidate-root", priorRelease,
      "--archive", `${priorRelease}/yt2sheet-linux-x64.tar.gz`,
      "--target", "linux-x64",
      "--gate", "prior-release-smoke",
      "--receipt", `${priorRelease}/receipts/prior-release-smoke.json`,
      "--workspace", `${root}/prior-release-smoke-workspace`
    ], { cwd: projectRoot, encoding: "utf8" });
    assert.equal(priorSmoke.status, 0, priorSmoke.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate verifier rejects a forged two-line hard-block TAP artifact", () => {
  const root = mkdtempSync(`${tmpdir()}/yt2sheet-forged-hard-block-`);
  try {
    const prepared = runHarness(root);
    assert.equal(prepared.status, 0, prepared.stderr);
    const fixture = `${root}/fixture`;
    const transcriptPath = `${fixture}/receipts/packaged-process/hard-block.tap`;
    const forged = Buffer.from("# pass 1\n# fail 0\n");
    writeFileSync(transcriptPath, forged);
    const receiptPath = `${fixture}/receipts/packaged-hard-block.json`;
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    receipt.evidence = [{ path: "receipts/packaged-process/hard-block.tap", sha256: sha256(forged), size: forged.byteLength }];
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

    const publication = `${root}/publication`;
    const result = runVerifier(fixture, publication);

    assert.notEqual(result.status, 0, "summary-only TAP must not authorize the packaged hard-block gate");
    assert.equal(existsSync(publication), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production assembler blocks a compliance mutation before publication reachability", () => {
  const root = mkdtempSync(`${tmpdir()}/yt2sheet-compliance-publication-`);
  try {
    const prepared = runHarness(root);
    assert.equal(prepared.status, 0, prepared.stderr);
    const fixture = `${root}/fixture`;
    writeFileSync(`${fixture}/assets/THIRD_PARTY_NOTICES.md`, "# Third-Party Notices\n\nMutated after process gates.\n");
    const publication = `${root}/complete-release-candidate`;

    const result = spawnSync(process.execPath, [candidateAssembler, "--candidate-root", fixture, "--package-json", `${fixture}/package.json`, "--publication-dir", publication], { cwd: projectRoot, encoding: "utf8" });

    assert.notEqual(result.status, 0, "a post-gate compliance mutation must not reach the upload/publication boundary");
    assert.equal(existsSync(publication), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow-equivalent mutations cannot create the complete release candidate upload", async (t) => {
  const cases = [
    ["archive", "native-ubuntu22-x64"],
    ["receipt", "install-uninstall"],
    ["compliance", "archive-derived-compliance"],
    ["benchmark", "benchmark-promotion"],
    ["size", "size-budget"]
  ];
  for (const [scenario, gate] of cases) await t.test(scenario, () => {
    const root = mkdtempSync(`${tmpdir()}/yt2sheet-workflow-${scenario}-`);
    try {
      const prepared = runHarness(root);
      assert.equal(prepared.status, 0, prepared.stderr);
      const fixture = `${root}/fixture`;
      const publication = `${root}/complete-release-candidate`;
      const assemblerArgs = [candidateAssembler, "--candidate-root", fixture, "--package-json", `${fixture}/package.json`, "--publication-dir", publication];

      if (scenario === "archive") {
        const path = `${fixture}/assets/yt2sheet-linux-x64.tar.gz`;
        writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from("corrupt-after-native-process\n")]));
      } else if (scenario === "receipt") {
        const path = `${fixture}/receipts/install-uninstall.json`;
        const receipt = JSON.parse(readFileSync(path, "utf8"));
        receipt.facts.installed = false;
        writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
      } else if (scenario === "compliance") {
        writeFileSync(`${fixture}/assets/THIRD_PARTY_NOTICES.md`, "# Third-Party Notices\n\nMutated after archive assembly.\n");
      } else if (scenario === "benchmark") {
        const reportPath = `${fixture}/receipts/benchmark-promotion-process.json`;
        const report = JSON.parse(readFileSync(reportPath, "utf8"));
        report.qualityClaimsAllowed = false;
        const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
        writeFileSync(reportPath, bytes);
        const receiptPath = `${fixture}/receipts/benchmark-promotion.json`;
        const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
        receipt.evidence = receipt.evidence.map((entry) => entry.path === "receipts/benchmark-promotion-process.json"
          ? { ...entry, sha256: sha256(bytes), size: bytes.byteLength }
          : entry);
        writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
      } else if (scenario === "size") {
        assemblerArgs.push("--max-total-bytes", "1");
      }

      const priorPath = `${fixture}/published/prior-good.bin`;
      const priorBefore = sha256(readFileSync(priorPath));
      const result = spawnSync(process.execPath, assemblerArgs, { cwd: projectRoot, encoding: "utf8" });

      assert.notEqual(result.status, 0, `${scenario} unexpectedly reached upload`);
      assert.match(result.stderr, new RegExp(gate));
      assert.equal(existsSync(publication), false);
      assert.equal(sha256(readFileSync(priorPath)), priorBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
