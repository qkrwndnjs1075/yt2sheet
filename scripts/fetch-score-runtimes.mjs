import { createHash } from "node:crypto";
import { access, chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cacheFileName, existingBytes, parseScoreRuntimeStageManifest, runCommand, sha256File, stagingLimits, treeBytes, verifiedArchive } from "./score-runtime-staging-io.mjs";
import { stageDeclaredFonts } from "./score-runtime-fonts.mjs";

export { cacheFileName, stagingLimits };

const tools = ["audiveris", "musescore"];
const defaultCommands = Object.freeze({ msiexec: "msiexec.exe", hdiutil: "/usr/bin/hdiutil", ditto: "/usr/bin/ditto", codesign: "/usr/bin/codesign", spctl: "/usr/sbin/spctl", dpkgDeb: "dpkg-deb" });

function parseVersionProbe(output, tool, expected) {
  if (output === expected) return expected;
  const lines = output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const escapedExpected = expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (tool === "audiveris" && lines.some((line) => new RegExp(`^-\\s*Version:\\s*${escapedExpected}$`, "u").test(line))) return expected;
  if (tool === "musescore" && lines.length === 1 && lines[0] === `MuseScore4 ${expected}`) return expected;
  return undefined;
}

async function findByBasename(root, expected) {
  const matches = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name.toLowerCase() === expected.toLowerCase()) matches.push(path);
    }
  }
  await visit(root);
  if (matches.length !== 1) throw new Error(`expected one executable named ${expected}, found ${matches.length}`);
  return matches[0];
}

async function copyDiscoveredInstallation(rawRoot, runtime, toolRoot) {
  const discovered = await findByBasename(rawRoot, basename(runtime.stagedExecutable));
  const executableParent = dirname(discovered);
  if (basename(executableParent).toLowerCase() === "bin") await cp(dirname(executableParent), toolRoot, { recursive: true, preserveTimestamps: true });
  else await cp(executableParent, join(toolRoot, "bin"), { recursive: true, preserveTimestamps: true });
}

export function assertArchiveListingSafe(listing) {
  for (const line of listing.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^\S+\s+\S+\s+\d+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+(.+)$/);
    if (!match) throw new Error("unparseable archive listing entry rejected");
    const [entry, target] = match[1].split(" -> ", 2);
    const path = entry.replace(/^\.\//, "");
    if (!path && entry === "./" && target === undefined) continue;
    if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) throw new Error(`archive traversal entry rejected: ${path}`);
    if (target === undefined) continue;
    if (!target || target.startsWith("/") || target.includes("\\")) throw new Error(`archive traversal entry rejected: ${target}`);
    const resolvedTarget = posix.normalize(posix.join(posix.dirname(path), target));
    if (resolvedTarget === ".." || resolvedTarget.startsWith("../")) throw new Error(`archive traversal entry rejected: ${target}`);
  }
}

async function extractRuntime(tool, runtime, archive, stageRoot, options) {
  const toolRoot = join(stageRoot, "tools", tool);
  const rawRoot = join(stageRoot, `.extract-${tool}`);
  await mkdir(rawRoot, { recursive: true });
  const timeoutSignal = AbortSignal.timeout(options.extractionTimeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const commandOptions = { signal, environment: options.environment };
  const extractionBudget = async () => Math.min(stagingLimits.installedBytes, stagingLimits.temporaryBytes - await treeBytes(stageRoot));
  if (runtime.extraction === "dmg-copy-app") {
    const mountRoot = join(stageRoot, `.mount-${tool}`);
    await mkdir(mountRoot);
    let attached = false;
    try {
      await runCommand(options.commands.hdiutil, ["attach", "-readonly", "-nobrowse", "-mountpoint", mountRoot, archive], { ...commandOptions, stdinText: "y\n" });
      attached = true;
      const appName = runtime.stagedExecutable.split("/").find((part) => part.endsWith(".app"));
      if (!appName) throw new Error(`missing app bundle in ${runtime.stagedExecutable}`);
      if (await treeBytes(join(mountRoot, appName)) > stagingLimits.installedBytes) throw new Error(`installed runtime exceeds ${stagingLimits.installedBytes} bytes`);
      await mkdir(toolRoot, { recursive: true });
      await runCommand(options.commands.ditto, [join(mountRoot, appName), join(toolRoot, appName)], commandOptions);
    } finally {
      if (attached) await runCommand(options.commands.hdiutil, ["detach", mountRoot], { environment: options.environment, signal: AbortSignal.timeout(30_000) });
      await rm(mountRoot, { recursive: true, force: true });
    }
  } else if (runtime.extraction === "msi-admin") {
    await runCommand(options.commands.msiexec, ["/a", archive, "/qn", `TARGETDIR=${rawRoot}`], { ...commandOptions, budgetRoot: rawRoot, budgetBytes: await extractionBudget() });
    const rawBytes = await treeBytes(rawRoot);
    if (rawBytes > stagingLimits.installedBytes) throw new Error(`installed runtime exceeds ${stagingLimits.installedBytes} bytes`);
    if (await treeBytes(stageRoot) + rawBytes > stagingLimits.temporaryBytes) throw new Error(`temporary staging exceeds ${stagingLimits.temporaryBytes} bytes`);
    await copyDiscoveredInstallation(rawRoot, runtime, toolRoot);
  } else if (runtime.extraction === "deb-extract") {
    const listing = await runCommand(options.commands.dpkgDeb, ["--contents", archive], commandOptions);
    assertArchiveListingSafe(listing.stdout);
    await runCommand(options.commands.dpkgDeb, ["-x", archive, rawRoot], { ...commandOptions, budgetRoot: rawRoot, budgetBytes: await extractionBudget() });
    const rawBytes = await treeBytes(rawRoot);
    if (rawBytes > stagingLimits.installedBytes) throw new Error(`installed runtime exceeds ${stagingLimits.installedBytes} bytes`);
    if (await treeBytes(stageRoot) + rawBytes > stagingLimits.temporaryBytes) throw new Error(`temporary staging exceeds ${stagingLimits.temporaryBytes} bytes`);
    await copyDiscoveredInstallation(rawRoot, runtime, toolRoot);
  } else {
    const appImage = join(stageRoot, `${tool}.AppImage`);
    await cp(archive, appImage);
    await chmod(appImage, 0o700);
    await runCommand(appImage, ["--appimage-extract"], { ...commandOptions, cwd: rawRoot, budgetRoot: rawRoot, budgetBytes: await extractionBudget() });
    const rawBytes = await treeBytes(rawRoot);
    if (rawBytes > stagingLimits.installedBytes) throw new Error(`installed runtime exceeds ${stagingLimits.installedBytes} bytes`);
    await rm(appImage, { force: true });
    if (await treeBytes(stageRoot) + rawBytes > stagingLimits.temporaryBytes) throw new Error(`temporary staging exceeds ${stagingLimits.temporaryBytes} bytes`);
    await cp(join(rawRoot, "squashfs-root"), toolRoot, { recursive: true, preserveTimestamps: true });
  }
  await rm(rawRoot, { recursive: true, force: true });
}

async function inventoryTree(root) {
  const entries = [];
  let bytes = 0;
  async function visit(path) {
    const item = await lstat(path);
    const entry = { path: relative(root, path).split(sep).join("/"), mode: (item.mode & 0o7777).toString(8).padStart(4, "0") };
    if (item.isSymbolicLink()) {
      const link = await readlink(path);
      const actual = await realpath(path).catch(() => { throw new Error(`dangling symlink rejected: ${entry.path}`); });
      const boundary = await realpath(join(root, "tools"));
      const escape = relative(boundary, actual);
      if (escape === ".." || escape.startsWith(`..${sep}`) || actual === boundary) throw new Error(`symlink traversal rejected: ${entry.path}`);
      entries.push({ ...entry, type: "symlink", target: link, sha256: createHash("sha256").update(link).digest("hex") });
    } else if (item.isDirectory()) {
      entries.push({ ...entry, type: "directory" });
      for (const child of (await readdir(path)).sort()) await visit(join(path, child));
    } else if (item.isFile()) {
      bytes += item.size;
      entries.push({ ...entry, type: "file", size: item.size, sha256: await sha256File(path) });
    } else throw new Error(`unsupported staged file type: ${entry.path}`);
  }
  for (const tool of tools) await visit(join(root, "tools", tool));
  return { entries, bytes };
}

async function commit(stageRoot, targetRoot) {
  const targetTools = join(targetRoot, "tools");
  const backupRoot = join(stageRoot, ".backup");
  await mkdir(targetTools, { recursive: true });
  await mkdir(backupRoot);
  const names = [...tools, "score-runtime-inventory.json"];
  const backedUp = [];
  const installed = [];
  try {
    for (const name of names) {
      const target = join(targetTools, name);
      try { await access(target); await rename(target, join(backupRoot, name)); backedUp.push(name); } catch (error) { if (error?.code !== "ENOENT") throw error; }
      await rename(join(stageRoot, "tools", name), target);
      installed.push(name);
    }
  } catch (error) {
    for (const name of installed.reverse()) await rm(join(targetTools, name), { recursive: true, force: true });
    for (const name of backedUp) await rename(join(backupRoot, name), join(targetTools, name));
    throw error;
  }
}

export async function stageScoreRuntimes(input) {
  const options = { offline: false, commands: defaultCommands, environment: {}, extractionTimeoutMs: 15 * 60 * 1000, ...input, commands: { ...defaultCommands, ...input.commands } };
  const manifestSource = await readFile(options.manifestPath, "utf8");
  const platform = parseScoreRuntimeStageManifest(manifestSource, options.platformId);
  const manifest = JSON.parse(manifestSource);
  await mkdir(dirname(resolve(options.targetRoot)), { recursive: true });
  const stageRoot = await mkdtemp(join(dirname(resolve(options.targetRoot)), ".score-runtime-stage-"));
  try {
    for (const tool of tools) {
      const runtime = platform.runtimes[tool];
      const archive = await verifiedArchive(runtime, options);
      await extractRuntime(tool, runtime, archive, stageRoot, options);
      const executable = join(stageRoot, runtime.stagedExecutable);
      const executableStat = await stat(executable).catch(() => { throw new Error(`missing staged executable: ${runtime.stagedExecutable}`); });
      if (!executableStat.isFile()) throw new Error(`staged executable is not a file: ${runtime.stagedExecutable}`);
      if (platform.os !== "windows" && (executableStat.mode & 0o111) === 0) throw new Error(`staged executable lost executable bit: ${runtime.stagedExecutable}`);
    }
    await stageDeclaredFonts({ manifest, stageRoot, options });
    const versionProbes = {};
    const runtimeTimeout = AbortSignal.timeout(options.extractionTimeoutMs);
    const runtimeSignal = options.signal ? AbortSignal.any([options.signal, runtimeTimeout]) : runtimeTimeout;
    for (const tool of tools) {
      const runtime = platform.runtimes[tool];
      const probe = await runCommand(join(stageRoot, runtime.stagedExecutable), runtime.versionProbe.args, { signal: runtimeSignal, environment: options.environment });
      const outputs = [probe.stdout, probe.stderr]
        .map((channel) => channel.replace(/\r\n?/g, "\n").trim())
        .filter((channel) => channel.length > 0);
      const observed = outputs.length === 1 ? parseVersionProbe(outputs[0], tool, runtime.versionProbe.expected) : undefined;
      if (observed !== runtime.versionProbe.expected) throw new Error(`version probe mismatch for ${tool}`);
      versionProbes[tool] = observed;
    }
    if (platform.os === "macos") {
      for (const tool of tools) {
        const runtime = platform.runtimes[tool];
        const appName = runtime.stagedExecutable.split("/").find((part) => part.endsWith(".app"));
        const appPath = join(stageRoot, "tools", tool, appName);
        await runCommand(options.commands.codesign, ["--verify", "--deep", "--strict", appPath], { signal: runtimeSignal, environment: options.environment });
        try {
          await runCommand(options.commands.spctl, ["--assess", "--type", "execute", appPath], { signal: runtimeSignal, environment: options.environment });
        } catch (error) {
          const signature = await runCommand(options.commands.codesign, ["-dv", "--verbose=4", appPath], { signal: runtimeSignal, environment: options.environment });
          const metadata = `${signature.stdout}\n${signature.stderr}`;
          if (!/^Signature=adhoc(?:\r?\n|$)/mu.test(metadata)) throw error;
        }
      }
    }
    const { entries, bytes } = await inventoryTree(stageRoot);
    if (bytes > stagingLimits.installedBytes) throw new Error(`installed runtimes exceed ${stagingLimits.installedBytes} bytes`);
    const temporary = await treeBytes(stageRoot);
    if (temporary > stagingLimits.temporaryBytes) throw new Error(`temporary staging exceeds ${stagingLimits.temporaryBytes} bytes`);
    const archives = Object.fromEntries(tools.map((tool) => {
      const runtime = platform.runtimes[tool];
      return [tool, { assetName: runtime.assetName, sha256: runtime.sha256, extraction: runtime.extraction, stagedExecutable: runtime.stagedExecutable }];
    }));
    const inventory = { schemaVersion: "score-runtime-inventory/1", platformId: platform.id, archives, versionProbes, entries };
    await mkdir(join(stageRoot, "tools"), { recursive: true });
    await writeFile(join(stageRoot, "tools", "score-runtime-inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
    const priorBytes = await existingBytes(join(resolve(options.targetRoot), "tools", "audiveris"))
      + await existingBytes(join(resolve(options.targetRoot), "tools", "musescore"))
      + await existingBytes(join(resolve(options.targetRoot), "tools", "score-runtime-inventory.json"));
    if (await treeBytes(stageRoot) + priorBytes > stagingLimits.temporaryBytes) throw new Error(`temporary staging exceeds ${stagingLimits.temporaryBytes} bytes`);
    await commit(stageRoot, resolve(options.targetRoot));
    return { platformId: platform.id, versionProbes, inventoryPath: join(resolve(options.targetRoot), "tools", "score-runtime-inventory.json") };
  } finally {
    await rm(stageRoot, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--offline") { flags.add(argument); continue; }
    if (!["--manifest", "--platform", "--target", "--cache"].includes(argument) || !argv[index + 1]) throw new Error(`invalid staging option: ${argument}`);
    values.set(argument, argv[index + 1]);
    index += 1;
  }
  return { values, flags };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const projectRoot = resolve(import.meta.dirname, "..");
  const result = await stageScoreRuntimes({
    manifestPath: resolve(values.get("--manifest") ?? join(projectRoot, "scripts/score-runtime-manifest.json")),
    platformId: values.get("--platform"), targetRoot: resolve(values.get("--target") ?? projectRoot),
    cacheRoot: resolve(values.get("--cache") ?? join(projectRoot, ".cache/score-runtimes")), offline: flags.has("--offline")
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
