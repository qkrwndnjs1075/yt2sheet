#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

function options(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) values.set(argv[index], argv[index + 1]);
  for (const name of ["--candidate-root", "--archive", "--target", "--receipt", "--workspace"]) {
    if (!values.get(name)) throw new Error(`missing ${name}`);
  }
  const candidateRoot = resolve(values.get("--candidate-root"));
  const archive = resolve(values.get("--archive"));
  const receipt = resolve(values.get("--receipt"));
  const workspace = resolve(values.get("--workspace"));
  for (const path of [archive, receipt]) {
    if (!path.startsWith(`${candidateRoot}${sep}`)) throw new Error(`path must be below candidate root: ${path}`);
  }
  if (workspace === candidateRoot || workspace.startsWith(`${candidateRoot}${sep}`)) throw new Error("workspace must be outside the candidate root");
  return { candidateRoot, archive, target: values.get("--target"), receipt, workspace, gate: values.get("--gate") };
}

function run(command, args, environment) {
  const result = spawnSync(command, args, { encoding: "utf8", env: environment, timeout: 120_000 });
  return { command: [command, ...args], exitCode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function requireZero(observation, label) {
  if (observation.exitCode !== 0) throw new Error(`${label} failed (${observation.exitCode}): ${observation.stderr}`);
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function waitForRemoval(path) {
  for (let attempt = 0; attempt < 120 && existsSync(path); attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return !existsSync(path);
}

const args = options(process.argv.slice(2));
await rm(args.workspace, { recursive: true, force: true });
const installRoot = join(args.workspace, "install");
await mkdir(installRoot, { recursive: true });
const archiveBytes = await readFile(args.archive);
const archiveSha256 = digest(archiveBytes);
const isWindows = args.target === "windows-x64";
const extract = args.archive.endsWith(".zip")
  ? process.platform === "win32"
    ? run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Expand-Archive -LiteralPath $env:YT2SHEET_ARCHIVE -DestinationPath $env:YT2SHEET_INSTALL_ROOT -Force"], { ...process.env, YT2SHEET_ARCHIVE: args.archive, YT2SHEET_INSTALL_ROOT: installRoot })
    : run("unzip", ["-q", args.archive, "-d", installRoot], process.env)
  : run("tar", ["-xzf", args.archive, "-C", installRoot], process.env);
requireZero(extract, "archive install");
const launcher = join(installRoot, "bin", isWindows ? "yt2.ps1" : "yt2");
if (!isWindows) await chmod(launcher, 0o755);
const home = join(args.workspace, "home");
const bin = join(args.workspace, "bin");
await mkdir(home, { recursive: true });
await mkdir(bin, { recursive: true });
const environment = {
  ...process.env,
  HOME: home,
  YT2SHEET_ROOT: installRoot,
  YT2SHEET_BIN_DIR: bin,
  YT2SHEET_PROFILE: join(home, ".profile")
};
const invoke = (commandArgs) => isWindows
  ? run("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", launcher, ...commandArgs], environment)
  : run(launcher, commandArgs, environment);
const doctor = invoke(["doctor", "--offline"]);
requireZero(doctor, "offline doctor");
const smoke = invoke(["version"]);
requireZero(smoke, "packaged smoke");
const uninstall = invoke(["uninstall"]);
requireZero(uninstall, "uninstall");
const uninstalled = await waitForRemoval(installRoot);
if (!uninstalled) throw new Error("uninstall command left the installed archive behind");
const gate = args.gate ?? (args.target === "linux-x64" ? "native-ubuntu22-x64" : `native-${args.target}`);
const processReportPath = join(dirname(args.receipt), `${gate}-archive-process.json`);
const processReport = {
  schemaVersion: "yt2sheet-archive-process/1",
  target: args.target,
  archive: basename(args.archive),
  archiveSha256,
  observations: { extract, doctor, smoke, uninstall },
  installed: true,
  uninstalled
};
await mkdir(dirname(args.receipt), { recursive: true });
await writeFile(processReportPath, `${JSON.stringify(processReport, null, 2)}\n`, "utf8");
const evidence = await Promise.all([args.archive, processReportPath].map(async (path) => {
  const bytes = await readFile(path);
  const pathFromRoot = relative(args.candidateRoot, path).split(sep).join("/");
  if (isAbsolute(pathFromRoot) || pathFromRoot.startsWith("../")) throw new Error(`unsafe evidence path: ${pathFromRoot}`);
  return { path: pathFromRoot, sha256: digest(bytes), size: bytes.byteLength };
}));
const gateFacts = gate === "ubuntu24-compatibility"
  ? { compatible: true }
  : gate === "offline-doctor"
    ? { offline: true, doctorExitCode: doctor.exitCode }
    : gate === "prior-release-smoke"
      ? { passed: true, priorSha256: archiveSha256 }
      : {};
await writeFile(args.receipt, `${JSON.stringify({
  schemaVersion: "yt2sheet-release-gate-receipt/1",
  gate,
  exitCode: 0,
  evidence,
  facts: {
    ...gateFacts,
    archiveSha256,
    installed: true,
    uninstalled: true,
    process: {
      installExitCode: extract.exitCode,
      doctorExitCode: doctor.exitCode,
      smokeExitCode: smoke.exitCode,
      uninstallExitCode: uninstall.exitCode
    }
  }
}, null, 2)}\n`, "utf8");
await rm(args.workspace, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ gate, archiveSha256, installed: true, uninstalled: true })}\n`);
