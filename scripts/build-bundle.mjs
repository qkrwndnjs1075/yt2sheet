import { access, chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stageScoreRuntimes } from "./fetch-score-runtimes.mjs";
import { replaceDirectory } from "./atomic-directory-swap.mjs";
import { stageBundleCompliance } from "./stage-bundle-compliance.mjs";
import { loadTestBundleFixture } from "./score-runtime-staging-io.mjs";

const projectRoot = resolve(import.meta.dirname, "..");

const bundleTargets = new Set([
  "windows-x64",
  "darwin-x64",
  "darwin-arm64",
  "linux-x64"
]);

function parseArgs(argv) {
  const values = new Map();
  const valueOptions = new Set(["--output", "--target", "--runtime-cache", "--runtime-manifest"]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--runtime-offline") {
      values.set(argument, "true");
      continue;
    }
    if (!valueOptions.has(argument)) {
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
export YT_DLP_JS_RUNTIME="$root/runtime/bin/node"
exec "$root/runtime/bin/node" "$root/app/dist-cli/cli/index.js" "$@"
`;
}

function windowsLauncher() {
  return `@echo off
setlocal EnableExtensions EnableDelayedExpansion
set "YT2SHEET_ROOT=%~dp0.."
set "YT_DLP_PATH=%YT2SHEET_ROOT%\\tools\\yt-dlp.exe"
set "YT_DLP_JS_RUNTIME=%YT2SHEET_ROOT%\\runtime\\node.exe"
if /I "%~1"=="uninstall" if "%~2"=="" goto uninstall
set "YT2SHEET_UNINSTALL_HANDOFF="
goto forward_args

:uninstall
set "YT2SHEET_UNINSTALL_HANDOFF=launcher"
goto forward_args

:forward_args
set "YT2SHEET_ARGS="
:next_arg
if "%~1"=="" goto invoke_cli
set "YT2SHEET_ARGS=%YT2SHEET_ARGS% "%~1""
shift
goto next_arg

:invoke_cli
"%YT2SHEET_ROOT%\\runtime\\node.exe" "%YT2SHEET_ROOT%\\app\\dist-cli\\cli\\index.js" %YT2SHEET_ARGS%
set "YT2SHEET_EXIT=!ERRORLEVEL!"
if not defined YT2SHEET_UNINSTALL_HANDOFF exit /b !YT2SHEET_EXIT!
if not "!YT2SHEET_EXIT!"=="0" exit /b !YT2SHEET_EXIT!
start "" /b powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command "$root = [Environment]::GetEnvironmentVariable('YT2SHEET_ROOT', 'Process'); Start-Sleep -Milliseconds 250; for ($attempt = 0; $attempt -lt 120 -and (Test-Path -LiteralPath $root); $attempt++) { try { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Stop } catch { Start-Sleep -Milliseconds 50 } }"
exit /b 0
`;
}

function windowsPowerShellLauncher() {
  return `$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$node = Join-Path $root "runtime\\node.exe"
$entry = Join-Path $root "app\\dist-cli\\cli\\index.js"
$previousYtDlpPath = $env:YT_DLP_PATH
$previousYtDlpJsRuntime = $env:YT_DLP_JS_RUNTIME
$previousRoot = $env:YT2SHEET_ROOT
$previousHandoff = $env:YT2SHEET_UNINSTALL_HANDOFF
$exitCode = 0

try {
  $env:YT_DLP_PATH = Join-Path $root "tools\\yt-dlp.exe"
  $env:YT_DLP_JS_RUNTIME = $node
  $env:YT2SHEET_ROOT = $root
  if ($args.Count -eq 1 -and $args[0] -ieq "uninstall") {
    $env:YT2SHEET_UNINSTALL_HANDOFF = "launcher"
    & $node $entry @args
    $exitCode = $LASTEXITCODE
    if ($exitCode -eq 0) {
      $cleanupCommand = '$root = [Environment]::GetEnvironmentVariable(''YT2SHEET_ROOT'', ''Process''); Start-Sleep -Milliseconds 250; for ($attempt = 0; $attempt -lt 120 -and (Test-Path -LiteralPath $root); $attempt++) { try { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Stop } catch { Start-Sleep -Milliseconds 50 } }'
      Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @("-NoProfile", "-NonInteractive", "-Command", $cleanupCommand)
    }
  } else {
    $env:YT2SHEET_UNINSTALL_HANDOFF = $null
    & $node $entry @args
    $exitCode = $LASTEXITCODE
  }
} finally {
  $env:YT_DLP_PATH = $previousYtDlpPath
  $env:YT_DLP_JS_RUNTIME = $previousYtDlpJsRuntime
  $env:YT2SHEET_ROOT = $previousRoot
  $env:YT2SHEET_UNINSTALL_HANDOFF = $previousHandoff
}

exit $exitCode
`;
}

const args = parseArgs(process.argv.slice(2));
const hostTarget = targetFor(process.platform, process.arch);
const requestedTarget = args.get("--target");
const target = requestedTarget ?? hostTarget;

if (!bundleTargets.has(target)) {
  throw new Error(`알 수 없는 번들 대상입니다: ${target}`);
}

const outputRoot = resolve(projectRoot, args.get("--output") ?? `build-bundle/${target}`);
const distRoot = resolve(projectRoot, "dist-cli");
const nodeModulesRoot = resolve(projectRoot, "node_modules");
const bootstrapModule = resolve(distRoot, "cli/yt-dlp-bootstrap.js");
const packageJsonPath = resolve(projectRoot, "package.json");
const packageLockPath = resolve(projectRoot, "package-lock.json");
const defaultRuntimeManifestPath = resolve(projectRoot, "scripts/score-runtime-manifest.json");
const runtimeManifestPath = resolve(projectRoot, args.get("--runtime-manifest") ?? defaultRuntimeManifestPath);
const runtimeCacheRoot = resolve(projectRoot, args.get("--runtime-cache") ?? ".cache/score-runtimes");
const fixturePath = process.env.YT2SHEET_TEST_BUNDLE_FIXTURE_CONFIG;
const productionRuntimeManifestPath = await realpath(defaultRuntimeManifestPath);
const usesProductionRuntimeManifest = await realpath(runtimeManifestPath).catch(() => runtimeManifestPath) === productionRuntimeManifestPath;
if (fixturePath && (process.env.NODE_ENV !== "test" || usesProductionRuntimeManifest)) throw new Error("local bundle fixture requires NODE_ENV=test and a custom runtime manifest");
const fixture = fixturePath ? await loadTestBundleFixture(resolve(fixturePath)) : {};
if (target !== hostTarget && (!fixturePath || fixture.target !== target)) {
  throw new Error(`현재 실행 환경(${hostTarget})과 번들 대상(${target})이 다릅니다.`);
}
const runtimePlatforms = {
  "windows-x64": "windows-2022-x64",
  "darwin-x64": "macos-14-x64",
  "darwin-arm64": "macos-14-arm64",
  "linux-x64": "ubuntu-22.04-x64"
};

await access(resolve(distRoot, "cli/index.js"));
await access(nodeModulesRoot);
await access(bootstrapModule);

const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
const { ensureYtDlpExecutable } = await import(pathToFileURL(bootstrapModule).href);
const ytDlpPath = fixture.ytDlpPath ?? await ensureYtDlpExecutable();

await mkdir(resolve(outputRoot, ".."), { recursive: true });
const bundleStageRoot = await mkdtemp(join(resolve(outputRoot, ".."), ".bundle-build-"));
try {
  await stageScoreRuntimes({
    manifestPath: runtimeManifestPath,
    platformId: runtimePlatforms[target],
    targetRoot: bundleStageRoot,
    cacheRoot: runtimeCacheRoot,
    offline: args.has("--runtime-offline"),
    commands: fixture.runtimeCommands,
    environment: fixture.runtimeEnvironment
  });

  const appRoot = join(bundleStageRoot, "app");
  const runtimeRoot = join(bundleStageRoot, "runtime");
  const toolsRoot = join(bundleStageRoot, "tools");
  const binRoot = join(bundleStageRoot, "bin");

  await cp(distRoot, join(appRoot, "dist-cli"), { recursive: true });
  await cp(nodeModulesRoot, join(appRoot, "node_modules"), { recursive: true });
  await mkdir(join(bundleStageRoot, "scripts"), { recursive: true });
  await cp(runtimeManifestPath, join(bundleStageRoot, "scripts", "score-runtime-manifest.json"));
  await cp(resolve(projectRoot, "vendor", "musicxml-4.0"), join(bundleStageRoot, "vendor", "musicxml-4.0"), { recursive: true });
  await mkdir(join(runtimeRoot, target.startsWith("windows-") ? "" : "bin"), { recursive: true });
  await mkdir(toolsRoot, { recursive: true });
  await mkdir(binRoot, { recursive: true });

  const isWindows = target.startsWith("windows-");
  const runtimePath = isWindows ? join(runtimeRoot, "node.exe") : join(runtimeRoot, "bin/node");
  const bundledYtDlpPath = join(toolsRoot, isWindows ? "yt-dlp.exe" : "yt-dlp");
  await cp(target === hostTarget ? process.execPath : fixture.runtimeNodePath, runtimePath);
  await cp(ytDlpPath, bundledYtDlpPath);

  const launcherPath = join(binRoot, isWindows ? "yt2.cmd" : "yt2");
  await writeFile(launcherPath, isWindows ? windowsLauncher() : unixLauncher(), "utf8");
  if (isWindows) {
    await writeFile(join(binRoot, "yt2.ps1"), windowsPowerShellLauncher(), "utf8");
  }
  await writeFile(
    join(bundleStageRoot, "VERSION"),
    `${packageJson.name} ${packageJson.version} ${target}\n`,
    "utf8"
  );

  if (!isWindows) {
    await chmod(runtimePath, 0o755);
    await chmod(bundledYtDlpPath, 0o755);
    await chmod(launcherPath, 0o755);
  }

  await stageBundleCompliance({
    generatorPath: fixture.complianceGeneratorPath ?? resolve(projectRoot, "scripts/generate-third-party-compliance.mjs"),
    environment: fixture.complianceEnvironment,
    runtimeManifestPath,
    packageLockPath,
    platformId: runtimePlatforms[target],
    bundleRoot: bundleStageRoot,
    offline: args.has("--runtime-offline")
  });
  await replaceDirectory(bundleStageRoot, outputRoot);
  process.stdout.write(`번들 생성 완료: ${outputRoot}\n`);
} finally {
  await rm(bundleStageRoot, { recursive: true, force: true });
}
