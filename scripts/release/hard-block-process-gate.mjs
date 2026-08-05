#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const SCHEMA_VERSION = "yt2sheet-hard-block-process/1";
const SELECTED_TEST = "blocked processor outcome leaves an existing output untouched";
const REQUIRED_TEST_PATH = "receipts/packaged-process/hard-block-harness/build-test/tests/cli-publication-contract.test.js";
const PROCESS_TIMEOUT_MS = 5_000;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) values.set(argv[index], argv[index + 1]);
  for (const name of ["--candidate-root", "--test-file", "--report"]) if (!values.get(name)) throw new Error(`missing ${name}`);
  return { candidateRoot: resolve(values.get("--candidate-root")), testFile: resolve(values.get("--test-file")), report: resolve(values.get("--report")) };
}

function relativeCandidatePath(root, path) {
  const candidatePath = relative(root, path).split(sep).join("/");
  if (candidatePath === ".." || candidatePath.startsWith("../")) throw new Error(`path must be below candidate root: ${path}`);
  return candidatePath;
}

function testArguments(testFile) {
  return ["--test", "--test-reporter=tap", `--test-name-pattern=^${SELECTED_TEST}$`, testFile];
}

function observations(stdout) {
  const escapedName = SELECTED_TEST.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const selectedSubtestPassed = new RegExp(`^ok \\d+ - ${escapedName}(?:$| #)`, "mu").test(stdout);
  const pass = Number(stdout.match(/^# pass (\d+)$/mu)?.[1] ?? -1);
  const fail = Number(stdout.match(/^# fail (\d+)$/mu)?.[1] ?? -1);
  return { selectedSubtestPassed, pass, fail };
}

function execute(testFile) {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  delete environment.NODE_TEST_REPORTER;
  delete environment.NODE_TEST_REPORTER_DESTINATION;
  const result = spawnSync(process.execPath, testArguments(testFile), { encoding: "utf8", env: environment, timeout: PROCESS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  return {
    exitCode: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    observations: observations(result.stdout)
  };
}

function assertGreen(result, fail) {
  if (result.exitCode !== 0 || result.signal !== null) fail("compiled hard-block harness did not exit zero");
  if (!result.observations.selectedSubtestPassed || result.observations.pass !== 1 || result.observations.fail !== 0) {
    fail("compiled hard-block harness did not prove the selected blocking outcome");
  }
}

export async function writeHardBlockProcessReport({ candidateRoot, testFile, reportPath }) {
  const testPath = relativeCandidatePath(candidateRoot, testFile);
  if (testPath !== REQUIRED_TEST_PATH) throw new Error(`hard-block harness path must equal ${REQUIRED_TEST_PATH}`);
  const testBytes = await readFile(testFile);
  const result = execute(testFile);
  const report = {
    schemaVersion: SCHEMA_VERSION,
    testFile: testPath,
    testFileSha256: sha256(testBytes),
    argv: testArguments(testPath),
    selectedTest: SELECTED_TEST,
    timeoutMs: PROCESS_TIMEOUT_MS,
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutSha256: sha256(result.stdout),
    observations: result.observations
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  assertGreen(result, (detail) => { throw new Error(detail); });
  return report;
}

export async function verifyHardBlockProcessReport({ candidateRoot, receipt, fail }) {
  const reportEvidence = receipt.evidence.find((entry) => entry.path === "receipts/packaged-process/hard-block-process.json");
  const testEvidence = receipt.evidence.find((entry) => entry.path === REQUIRED_TEST_PATH);
  if (!reportEvidence || !testEvidence) fail("compiled harness report and test evidence are required");
  let report;
  try {
    report = JSON.parse(await readFile(resolve(candidateRoot, reportEvidence.path), "utf8"));
  } catch {
    fail("compiled harness process report is missing or malformed");
  }
  if (report.schemaVersion !== SCHEMA_VERSION || report.testFile !== REQUIRED_TEST_PATH || report.selectedTest !== SELECTED_TEST || report.timeoutMs !== PROCESS_TIMEOUT_MS) {
    fail("compiled harness process report identity is invalid");
  }
  const testFile = resolve(candidateRoot, report.testFile);
  const testBytes = await readFile(testFile).catch(() => fail("compiled harness test file is missing"));
  if (sha256(testBytes) !== report.testFileSha256 || testEvidence.sha256 !== report.testFileSha256) fail("compiled harness source digest mismatch");
  if (JSON.stringify(report.argv) !== JSON.stringify(testArguments(REQUIRED_TEST_PATH)) || sha256(report.stdout) !== report.stdoutSha256) {
    fail("compiled harness command or stdout digest mismatch");
  }
  assertGreen(report, fail);
  const rerun = execute(testFile);
  assertGreen(rerun, fail);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await writeHardBlockProcessReport({ candidateRoot: args.candidateRoot, testFile: args.testFile, reportPath: args.report });
  process.stdout.write(`${JSON.stringify({ gate: "packaged-hard-block", exitCode: report.exitCode, selectedTest: report.selectedTest })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
