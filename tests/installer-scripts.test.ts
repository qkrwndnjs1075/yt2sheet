import assert from "node:assert/strict";
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
  assert.match(powershell, /"cli-v0\.2\.3"/, "the raw installer must default to the latest published CLI release");
  assert.match(shell, /YT2SHEET_RELEASE_TAG:-cli-v0\.2\.3/, "the Unix installer must default to the same latest CLI release");
  assert.match(powershell, /\(\?:release-assets\/\)\?/, "the PowerShell installer must accept GitHub Release checksum paths");
  assert.match(shell, /\$2 == "release-assets\/" name/, "the Unix installer must accept GitHub Release checksum paths");
  assert.match(powershell, /### \[\{0\}\/\{1\}\]/);
  assert.match(shell, /### \[%s\/%s\]/);
  assert.match(powershell, /SetEnvironmentVariable\("Path",/);
  assert.match(powershell, /yt2\.cmd/);
  assert.doesNotMatch(powershell, /Invoke-WebRequest/, "Windows PowerShell 5.1 must not use Invoke-WebRequest for the large GitHub release archive");
  assert.match(powershell, /System\.Net\.WebClient/, "the raw installer must use the .NET downloader that survives the release-asset transfer");
  assert.match(powershell, /if \(\$null -ne \$client\)/, "the raw installer must not call a method on a missing download client");
  assert.match(powershell, /LOCALAPPDATA is not available/, "the raw installer must report a missing Windows install location");
  assert.match(bundleBuilder, /YT2SHEET_UNINSTALL_HANDOFF=launcher/, "the Windows launcher must hand final root deletion to the exited batch process");
  assert.match(bundleBuilder, /Start-Sleep -Milliseconds 250/, "the Windows launcher cleanup must wait for the launcher process to exit");
  assert.match(bundleBuilder, /Remove-Item -LiteralPath \$root -Recurse -Force/, "the Windows launcher must remove the bundle after the runtime exits");
  assert.match(readme, /irm https:\/\/raw\.githubusercontent\.com\/qkrwndnjs1075\/yt2sheet\/main\/scripts\/install\.ps1 \| iex/);
  assert.match(readme, /yt2 "https:\/\/www\.youtube\.com\/watch\?v=VIDEO_ID"/);
  assert.match(readme, /wrap the entire URL in double quotes/);
});
