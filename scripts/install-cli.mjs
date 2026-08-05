import { access, readFile, rm } from "node:fs/promises";
import { arch as hostArchitecture, platform as hostPlatform } from "node:process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stageScoreRuntimes } from "./fetch-score-runtimes.mjs";

const packageRoot = resolve(import.meta.dirname, "..");

export function maySkipToolInstall(environment) {
  return environment.CI === "1"
    || environment.CI === "true"
    || environment.NODE_ENV === "development";
}

export async function resolveScoreRuntimePlatform(options = {}) {
  const platform = options.platform ?? hostPlatform;
  const architecture = options.architecture ?? hostArchitecture;
  const environment = options.environment ?? process.env;
  if (architecture !== "x64" && architecture !== "arm64") {
    throw new Error(`yt2sheet score runtimes do not support ${platform}-${architecture}`);
  }
  if (platform === "win32" && architecture === "x64") return "windows-2022-x64";
  if (platform === "darwin") return architecture === "arm64" ? "macos-14-arm64" : "macos-14-x64";
  if (platform !== "linux" || architecture !== "x64") {
    throw new Error(`yt2sheet score runtimes do not support ${platform}-${architecture}`);
  }

  const osReleasePath = environment.YT2SHEET_OS_RELEASE_FILE || "/etc/os-release";
  const source = await (options.readText ?? readFile)(osReleasePath, "utf8");
  const fields = Object.fromEntries(source.split(/\r?\n/u).flatMap((line) => {
    const match = /^([A-Z_]+)=(?:"([^"]*)"|'([^']*)'|([^#\s]*))$/u.exec(line);
    return match?.[1] ? [[match[1], match[2] ?? match[3] ?? match[4] ?? ""]] : [];
  }));
  if (fields.ID !== "ubuntu" || (fields.VERSION_ID !== "22.04" && fields.VERSION_ID !== "24.04")) {
    throw new Error(`yt2sheet score runtimes require Ubuntu 22.04/24.04 x64; found ${fields.ID ?? "unknown"} ${fields.VERSION_ID ?? "unknown"}`);
  }
  return `ubuntu-${fields.VERSION_ID}-x64`;
}

export async function installScoreRuntimes(options = {}) {
  const root = resolve(options.packageRoot ?? packageRoot);
  const environment = options.environment ?? process.env;
  const platformId = await resolveScoreRuntimePlatform({
    platform: options.platform,
    architecture: options.architecture,
    environment,
    readText: options.readText
  });
  const cacheRoot = resolve(root, ".score-runtime-install-cache");
  try {
    return await (options.stageRuntimes ?? stageScoreRuntimes)({
      manifestPath: resolve(root, "scripts/score-runtime-manifest.json"),
      platformId,
      targetRoot: root,
      cacheRoot,
      environment
    });
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
}

export async function runPackageInstall(options = {}) {
  const environment = options.environment ?? process.env;
  if (environment.YT2SHEET_SKIP_TOOL_INSTALL === "1") {
    if (!maySkipToolInstall(environment)) {
      throw new Error("YT2SHEET_SKIP_TOOL_INSTALL=1 is allowed only in CI or NODE_ENV=development");
    }
    process.stdout.write("yt2sheet: CI/development tool installation skipped; doctor must fail until bundled tools are installed.\n");
    return;
  }

  const compiledBootstrap = resolve(options.packageRoot ?? packageRoot, "dist-cli/cli/yt-dlp-bootstrap.js");
  process.stdout.write("### [1/4] yt-dlp preparing\n");
  await access(compiledBootstrap);
  const { ensureYtDlpExecutable } = await import(pathToFileURL(compiledBootstrap).href);
  await ensureYtDlpExecutable((progress) => writeProgress(progress));
  process.stdout.write("### [2/4] yt-dlp ready\n");
  process.stdout.write("### [3/4] pinned score runtimes preparing\n");
  const installedRuntimes = await installScoreRuntimes(options);
  process.stdout.write("### [4/4] package tools ready\n");
  process.stdout.write(`yt2sheet score runtimes ready (${installedRuntimes.platformId})\n`);
}

function writeProgress(progress) {
  const labels = {
    checking: "checking",
    checksum: "checksum",
    download: "downloading",
    verify: "verifying",
    ready: "ready"
  };
  const detail = progress.phase === "download" && progress.totalBytes === undefined && progress.downloadedBytes !== undefined
    ? `${Math.max(1, Math.round(progress.downloadedBytes / 1024))} KiB`
    : `${progress.percent}%`;
  process.stdout.write(`\r### yt-dlp ${labels[progress.phase]} ${detail}`);
  if (progress.phase === "ready") process.stdout.write("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runPackageInstall();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`yt2sheet postinstall failed: ${message}\n`);
    process.exitCode = 1;
  }
}
