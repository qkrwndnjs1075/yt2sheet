import { access, chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot = resolve(import.meta.dirname, "..");

const bundleTargets = new Set([
  "windows-x64",
  "darwin-x64",
  "darwin-arm64",
  "linux-x64"
]);

function parseArgs(argv) {
  const values = new Map();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--output" && argument !== "--target") {
      throw new Error(`알 수 없는 옵션입니다: ${argument}`);
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} 값이 필요합니다.`);
    }

    values.set(argument, value);
    index += 1;
  }

  return values;
}

function targetFor(platform, arch) {
  if (platform === "win32" && arch === "x64") {
    return "windows-x64";
  }
  if (platform === "darwin" && arch === "x64") {
    return "darwin-x64";
  }
  if (platform === "darwin" && arch === "arm64") {
    return "darwin-arm64";
  }
  if (platform === "linux" && arch === "x64") {
    return "linux-x64";
  }

  throw new Error(`현재 환경은 지원하지 않습니다: ${platform}-${arch}`);
}

function unixLauncher() {
  return `#!/bin/sh
set -eu
script_path="$0"
while [ -L "$script_path" ]; do
  link_path=$(readlink "$script_path")
  case "$link_path" in
    /*) script_path="$link_path" ;;
    *) script_path="$(dirname -- "$script_path")/$link_path" ;;
  esac
done
root=$(CDPATH= cd -- "$(dirname -- "$script_path")/.." && pwd)
export YT_DLP_PATH="$root/tools/yt-dlp"
exec "$root/runtime/bin/node" "$root/app/dist-cli/cli/index.js" "$@"
`;
}

function windowsLauncher() {
  return `@echo off
setlocal EnableExtensions EnableDelayedExpansion
set "YT2SHEET_ROOT=%~dp0.."
set "YT_DLP_PATH=%YT2SHEET_ROOT%\\tools\\yt-dlp.exe"
if /I "%~1"=="uninstall" if "%~2"=="" goto uninstall
"%YT2SHEET_ROOT%\\runtime\\node.exe" "%YT2SHEET_ROOT%\\app\\dist-cli\\cli\\index.js" %*
exit /b %ERRORLEVEL%

:uninstall
set "YT2SHEET_UNINSTALL_HANDOFF=launcher"
"%YT2SHEET_ROOT%\\runtime\\node.exe" "%YT2SHEET_ROOT%\\app\\dist-cli\\cli\\index.js" %*
set "YT2_UNINSTALL_EXIT=!ERRORLEVEL!"
if not "!YT2_UNINSTALL_EXIT!"=="0" exit /b !YT2_UNINSTALL_EXIT!
start "" /b powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command "$root = [Environment]::GetEnvironmentVariable('YT2SHEET_ROOT', 'Process'); Start-Sleep -Milliseconds 250; for ($attempt = 0; $attempt -lt 120 -and (Test-Path -LiteralPath $root); $attempt++) { try { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Stop } catch { Start-Sleep -Milliseconds 50 } }"
exit /b 0
`;
}

const args = parseArgs(process.argv.slice(2));
const hostTarget = targetFor(process.platform, process.arch);
const requestedTarget = args.get("--target");
const target = requestedTarget ?? hostTarget;

if (!bundleTargets.has(target)) {
  throw new Error(`알 수 없는 번들 대상입니다: ${target}`);
}
if (target !== hostTarget) {
  throw new Error(`현재 실행 환경(${hostTarget})과 번들 대상(${target})이 다릅니다.`);
}

const outputRoot = resolve(projectRoot, args.get("--output") ?? `build-bundle/${target}`);
const distRoot = resolve(projectRoot, "dist-cli");
const nodeModulesRoot = resolve(projectRoot, "node_modules");
const bootstrapModule = resolve(distRoot, "cli/yt-dlp-bootstrap.js");
const packageJsonPath = resolve(projectRoot, "package.json");

await access(resolve(distRoot, "cli/index.js"));
await access(nodeModulesRoot);
await access(bootstrapModule);

const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
const { ensureYtDlpExecutable } = await import(pathToFileURL(bootstrapModule).href);
const ytDlpPath = await ensureYtDlpExecutable();

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const appRoot = join(outputRoot, "app");
const runtimeRoot = join(outputRoot, "runtime");
const toolsRoot = join(outputRoot, "tools");
const binRoot = join(outputRoot, "bin");

await cp(distRoot, join(appRoot, "dist-cli"), { recursive: true });
await cp(nodeModulesRoot, join(appRoot, "node_modules"), { recursive: true });
await mkdir(join(runtimeRoot, target.startsWith("windows-") ? "" : "bin"), { recursive: true });
await mkdir(toolsRoot, { recursive: true });
await mkdir(binRoot, { recursive: true });

const isWindows = target.startsWith("windows-");
const runtimePath = isWindows ? join(runtimeRoot, "node.exe") : join(runtimeRoot, "bin/node");
const bundledYtDlpPath = join(toolsRoot, isWindows ? "yt-dlp.exe" : "yt-dlp");
await cp(process.execPath, runtimePath);
await cp(ytDlpPath, bundledYtDlpPath);

const launcherPath = join(binRoot, isWindows ? "yt2.cmd" : "yt2");
await writeFile(launcherPath, isWindows ? windowsLauncher() : unixLauncher(), "utf8");
await writeFile(
  join(outputRoot, "VERSION"),
  `${packageJson.name} ${packageJson.version} ${target}\n`,
  "utf8"
);

if (!isWindows) {
  await chmod(runtimePath, 0o755);
  await chmod(bundledYtDlpPath, 0o755);
  await chmod(launcherPath, 0o755);
}

process.stdout.write(`번들 생성 완료: ${outputRoot}\n`);
