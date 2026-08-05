import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, lstat } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const tools = ["audiveris", "musescore"], extractions = new Set(["msi-admin", "dmg-copy-app", "deb-extract", "appimage-extract"]);
const authoritativeVersions = Object.freeze({ audiveris: "5.11.0", musescore: "4.7.4" });
const platformIds = new Set(["macos-14-arm64", "macos-14-x64", "ubuntu-22.04-x64", "ubuntu-24.04-x64", "windows-2022-x64"]);
const platformContracts = Object.freeze({
  "macos-14-arm64": ["darwin-arm64", "macos", "14", "arm64", "dmg-copy-app", "dmg-copy-app"],
  "macos-14-x64": ["darwin-x64", "macos", "14", "x64", "dmg-copy-app", "dmg-copy-app"],
  "ubuntu-22.04-x64": ["linux-x64", "ubuntu", "22.04", "x64", "deb-extract", "appimage-extract"],
  "ubuntu-24.04-x64": ["linux-x64", "ubuntu", "24.04", "x64", "deb-extract", "appimage-extract"],
  "windows-2022-x64": ["windows-x64", "windows", "2022", "x64", "msi-admin", "msi-admin"]
});

export const stagingLimits = Object.freeze({
  archiveBytes: 750 * 1024 * 1024,
  installedBytes: 2 * 1024 * 1024 * 1024,
  temporaryBytes: 4 * 1024 * 1024 * 1024
});

export async function loadTestBundleFixture(path) {
  const fixture = JSON.parse(await readFile(path, "utf8"));
  const commandNames = ["msiexec", "hdiutil", "ditto", "codesign", "spctl", "dpkgDeb"];
  if (!fixture || typeof fixture.target !== "string" || typeof fixture.complianceGeneratorPath !== "string" || typeof fixture.ytDlpPath !== "string" || typeof fixture.runtimeNodePath !== "string"
    || Object.keys(fixture.runtimeCommands ?? {}).some((name) => !commandNames.includes(name) || typeof fixture.runtimeCommands[name] !== "string")
    || Object.values(fixture.runtimeEnvironment ?? {}).some((value) => typeof value !== "string")) {
    throw new Error("invalid local bundle fixture configuration");
  }
  const runtimeNode = await stat(fixture.runtimeNodePath).catch(() => undefined);
  if (!runtimeNode?.isFile() || runtimeNode.size === 0 || (runtimeNode.mode & 0o111) === 0) throw new Error("invalid local bundle fixture runtime node");
  return fixture;
}

export function parseScoreRuntimeStageManifest(source, platformId) {
  const manifest = JSON.parse(source);
  if (manifest?.schemaVersion !== "score-runtime-manifest/1" || !platformIds.has(platformId)) throw new Error(`unsupported score runtime target: ${platformId}`);
  for (const tool of tools) if (manifest.tools?.[tool]?.version !== authoritativeVersions[tool]) throw new Error(`unpinned authoritative version: ${tool}`);
  const matches = manifest.platforms?.filter((entry) => entry.id === platformId) ?? [];
  if (matches.length !== 1) throw new Error(`unsupported score runtime target: ${platformId}`);
  const platform = matches[0];
  const coordinates = [platform.releaseTarget, platform.os, platform.osVersion, platform.arch, platform.runtimes?.audiveris?.extraction, platform.runtimes?.musescore?.extraction];
  if (coordinates.join("\0") !== platformContracts[platformId].join("\0")) throw new Error(`unsupported score runtime target contract: ${platformId}`);
  for (const tool of tools) {
    const runtime = platform.runtimes?.[tool];
    if (!runtime || !/^[a-f0-9]{64}$/.test(runtime.sha256) || !extractions.has(runtime.extraction) || new URL(runtime.url).protocol !== "https:" || basename(runtime.assetName) !== runtime.assetName) throw new Error(`invalid runtime manifest entry: ${tool}`);
    for (const [path, label] of [[runtime.assetName, `${tool} assetName`], [runtime.stagedExecutable, `${tool} stagedExecutable`]]) {
      if (typeof path !== "string" || path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) throw new Error(`${label} contains traversal`);
    }
    if (!runtime.stagedExecutable.startsWith(`tools/${tool}/`) || !Array.isArray(runtime.versionProbe?.args) || runtime.versionProbe.args.length === 0
      || runtime.versionProbe.expected !== authoritativeVersions[tool]) throw new Error(`invalid runtime manifest entry: ${tool}`);
  }
  return platform;
}

export function cacheFileName(runtime) {
  return `${runtime.sha256}-${runtime.assetName}`;
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

export async function verifiedArchive(runtime, options) {
  await mkdir(options.cacheRoot, { recursive: true });
  const cachePath = join(options.cacheRoot, cacheFileName(runtime));
  try {
    const cached = await stat(cachePath);
    if (cached.size > stagingLimits.archiveBytes) throw new Error(`archive exceeds ${stagingLimits.archiveBytes} bytes`);
    if (await sha256File(cachePath) === runtime.sha256) return cachePath;
    if (options.offline) throw new Error(`cached archive SHA-256 mismatch for ${runtime.assetName}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    if (options.offline) throw new Error(`offline cache is missing ${runtime.assetName}`);
  }
  const response = await fetch(runtime.url, { signal: options.signal, redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`download failed for ${runtime.assetName}: HTTP ${response.status}`);
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > stagingLimits.archiveBytes) throw new Error(`archive exceeds ${stagingLimits.archiveBytes} bytes`);
  const partPath = `${cachePath}.part-${process.pid}-${Date.now()}`;
  let received = 0;
  const limiter = new Transform({ transform(chunk, _encoding, callback) {
    received += chunk.length;
    callback(received <= stagingLimits.archiveBytes ? undefined : new Error(`archive exceeds ${stagingLimits.archiveBytes} bytes`), chunk);
  } });
  try {
    await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(partPath, { mode: 0o600 }), { signal: options.signal });
    if (await sha256File(partPath) !== runtime.sha256) throw new Error(`downloaded archive SHA-256 mismatch for ${runtime.assetName}`);
    await rm(cachePath, { force: true });
    await rename(partPath, cachePath);
    return cachePath;
  } finally {
    await rm(partPath, { force: true });
  }
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd, signal: options.signal, windowsHide: true,
      env: { ...process.env, ...options.environment },
      stdio: [typeof options.stdinText === "string" ? "pipe" : "ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    let budgetError;
    let checkingBudget = false;
    const budgetTimer = options.budgetRoot ? setInterval(() => {
      if (checkingBudget || budgetError) return;
      checkingBudget = true;
      treeBytes(options.budgetRoot).then((bytes) => {
        if (bytes > options.budgetBytes) {
          budgetError = new Error(`temporary extraction exceeds ${options.budgetBytes} bytes`);
          child.kill("SIGKILL");
        }
      }).catch((error) => { if (error?.code !== "ENOENT") budgetError = error; }).finally(() => { checkingBudget = false; });
    }, 25) : undefined;
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    if (typeof options.stdinText === "string") child.stdin.end(options.stdinText);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (budgetTimer) clearInterval(budgetTimer);
      const output = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (budgetError) reject(budgetError);
      else if (code === 0) resolvePromise(output);
      else reject(new Error(`${basename(command)} command failed (${signal ?? code}): ${output.stderr.trim()}`));
    });
  });
}

export async function treeBytes(root) {
  let bytes = 0;
  async function visit(path) {
    const item = await lstat(path);
    if (item.isFile()) bytes += item.size;
    if (item.isDirectory()) for (const child of await readdir(path)) await visit(join(path, child));
  }
  await visit(root);
  return bytes;
}

export async function existingBytes(path) {
  try { return await treeBytes(path); }
  catch (error) { if (error?.code === "ENOENT") return 0; throw error; }
}
