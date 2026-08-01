import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("raw PowerShell installer is pipe-safe and surfaces staged progress", async () => {
  const [powershell, shell, readme, bundleBuilder] = await Promise.all([
    readFile("scripts/install.ps1", "utf8"),
    readFile("scripts/install.sh", "utf8"),
    readFile("README.md", "utf8"),
    readFile("scripts/build-bundle.mjs", "utf8")
  ]);

  assert.notEqual(powershell.charCodeAt(0), 0xFEFF, "a UTF-8 BOM becomes part of `param` when the raw installer is piped to iex");
  assert.match(powershell, /releases\/latest\/download/, "the raw installer must resolve the latest published CLI release without a version pin");
  assert.match(shell, /releases\/latest\/download/, "the Unix installer must resolve the latest published CLI release without a version pin");
  assert.doesNotMatch(powershell, /cli-v0\.2\.5/, "the raw installer command must not need a release-specific update");
  assert.doesNotMatch(shell, /cli-v0\.2\.5/, "the Unix installer command must not need a release-specific update");
  assert.match(powershell, /releases\/download\/\$ReleaseTag/, "an explicit PowerShell release tag must remain reproducible");
  assert.match(shell, /releases\/download\/\$release_tag/, "an explicit Unix release tag must remain reproducible");
  assert.match(powershell, /\(\?:release-assets\/\)\?/, "the PowerShell installer must accept GitHub Release checksum paths");
  assert.match(shell, /\$2 == "release-assets\/" name/, "the Unix installer must accept GitHub Release checksum paths");
  assert.match(powershell, /### \[\{0\}\/\{1\}\]/);
  assert.match(powershell, /\$progressState = \[pscustomobject\]@\{/);
  assert.match(powershell, /\[psobject\]\$ProgressState/);
  assert.match(powershell, /-ProgressState \$progressState/);
  assert.doesNotMatch(powershell, /\$script:(?:currentStep|totalSteps)/, "progress state must survive evaluation inside an outer PowerShell script block");
  assert.match(shell, /### \[%s\/%s\]/);
  assert.match(powershell, /SetEnvironmentVariable\("Path",/);
  assert.match(powershell, /yt2\.cmd/);
  assert.doesNotMatch(powershell, /Invoke-WebRequest/, "Windows PowerShell 5.1 must not use Invoke-WebRequest for the large GitHub release archive");
  assert.match(powershell, /System\.Net\.WebClient/, "the raw installer must use the .NET downloader that survives the release-asset transfer");
  assert.match(powershell, /if \(\$null -ne \$client\)/, "the raw installer must not call a method on a missing download client");
  assert.match(powershell, /LOCALAPPDATA is not available/, "the raw installer must report a missing Windows install location");
  assert.match(bundleBuilder, /YT2SHEET_UNINSTALL_HANDOFF=launcher/, "the Windows launcher must hand final root deletion to the exited batch process");
  assert.match(bundleBuilder, /function windowsPowerShellLauncher\(\)/, "PowerShell must use a native script launcher so ampersands never cross cmd.exe parsing");
  assert.match(bundleBuilder, /writeFile\(join\(binRoot, "yt2\.ps1"\)/, "Windows bundles must install the PowerShell launcher beside the CMD launcher");
  assert.match(bundleBuilder, /& \$node \$entry @args/, "the PowerShell launcher must forward the original argument array");
  assert.match(bundleBuilder, /Start-Sleep -Milliseconds 250/, "the Windows launcher cleanup must wait for the launcher process to exit");
  assert.match(bundleBuilder, /Remove-Item -LiteralPath \$root -Recurse -Force/, "the Windows launcher must remove the bundle after the runtime exits");
  assert.match(readme, /irm https:\/\/raw\.githubusercontent\.com\/qkrwndnjs1075\/yt2sheet\/main\/scripts\/install\.ps1 \| iex/);
  assert.match(readme, /yt2 "https:\/\/www\.youtube\.com\/watch\?v=VIDEO_ID"/);
  assert.match(readme, /wrap the entire URL in double quotes/);
});

test("Windows launcher preserves ampersands in each forwarded argument", async () => {
  const bundleBuilder = await readFile("scripts/build-bundle.mjs", "utf8");

  assert.match(bundleBuilder, /set "YT2SHEET_ARGS="/);
  assert.match(bundleBuilder, /if \"%~1\"==\"\" goto/);
  assert.match(bundleBuilder, /set "YT2SHEET_ARGS=%YT2SHEET_ARGS% \"%~1\""/);
  assert.doesNotMatch(bundleBuilder, /dist-cli\\cli\\index\.js" %\*/);
});

test("raw PowerShell installer uses the native environment when runtime architecture is empty", { skip: process.platform !== "win32" }, async () => {
  const powershell = await readFile("scripts/install.ps1", "utf8");
  const forcedEmptyRuntime = powershell.replace(
    "[string][System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture",
    '""'
  );
  assert.notEqual(forcedEmptyRuntime, powershell, "the regression harness must force the reported empty runtime architecture");

  const command = "$env:YT2SHEET_TEST_INSTALLER_PAYLOAD | Invoke-Expression";
  const encodedCommand = Buffer.from(command, "utf16le").toString("base64");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-EncodedCommand", encodedCommand], {
    encoding: "utf8",
    env: {
      ...process.env,
      PROCESSOR_ARCHITECTURE: "x86",
      PROCESSOR_ARCHITEW6432: "AMD64",
      YT2SHEET_RELEASE_BASE_URL: "http://127.0.0.1:1",
      YT2SHEET_INSTALL_ROOT: "unused-by-connection-failure",
      YT2SHEET_TEST_INSTALLER_PAYLOAD: forcedEmptyRuntime
    },
    timeout: 10_000
  });

  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, "the isolated download should stop at the deliberately closed endpoint");
  assert.match(result.stdout, /### \[1\/7\].*\(14%\)/, "AMD64 from the native environment must select the Windows x64 asset");
});

test("raw PowerShell installer reports progress inside an outer script block", { skip: process.platform !== "win32" }, async () => {
  const powershell = await readFile("scripts/install.ps1", "utf8");
  const command = [
    "$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:YT2SHEET_TEST_INSTALLER_PAYLOAD))",
    "& { $payload | Invoke-Expression }"
  ].join("\n");
  const encodedCommand = Buffer.from(command, "utf16le").toString("base64");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-EncodedCommand", encodedCommand], {
    encoding: "utf8",
    env: {
      ...process.env,
      YT2SHEET_RELEASE_BASE_URL: "http://127.0.0.1:1",
      YT2SHEET_INSTALL_ROOT: "unused-by-connection-failure",
      YT2SHEET_TEST_INSTALLER_PAYLOAD: Buffer.from(powershell, "utf8").toString("base64")
    },
    timeout: 10_000
  });

  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, "the isolated download should stop at the deliberately closed endpoint");
  assert.match(result.stdout, /### \[1\/7\].*\(14%\)/);
  assert.doesNotMatch(result.stderr, /divide by zero|null-valued expression/);
  assert.match(result.stderr, /yt2 installer failed:/);
  assert.match(result.stderr, /\$client\.DownloadFile\(\$Uri, \$Destination\)/);
  assert.match(result.stderr, /at Download-InstallFile, <No file>: line \d+/);
});
