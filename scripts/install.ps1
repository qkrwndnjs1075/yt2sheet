param(
  [string]$ReleaseTag,
  [string]$Repository,
  [string]$InstallRoot
)

$ErrorActionPreference = "Stop"

$installer = {
param(
  [string]$ReleaseTag,
  [string]$Repository,
  [string]$InstallRoot
)

if ([string]::IsNullOrWhiteSpace($ReleaseTag)) {
  $ReleaseTag = $env:YT2SHEET_RELEASE_TAG
}
if ([string]::IsNullOrWhiteSpace($Repository)) {
  $Repository = if ([string]::IsNullOrWhiteSpace($env:YT2SHEET_REPOSITORY)) { "qkrwndnjs1075/yt2sheet" } else { $env:YT2SHEET_REPOSITORY }
}
if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
  $localAppData = [Environment]::GetEnvironmentVariable("LOCALAPPDATA", "Process")
  $InstallRoot = if ([string]::IsNullOrWhiteSpace($env:YT2SHEET_INSTALL_ROOT)) {
    if ([string]::IsNullOrWhiteSpace($localAppData)) {
      throw "LOCALAPPDATA is not available. Pass -InstallRoot or set YT2SHEET_INSTALL_ROOT."
    }
    Join-Path $localAppData "yt2sheet"
  } else {
    $env:YT2SHEET_INSTALL_ROOT
  }
}

$architecture = [Environment]::GetEnvironmentVariable("PROCESSOR_ARCHITEW6432", "Process")
if ([string]::IsNullOrWhiteSpace($architecture)) {
  $architecture = [Environment]::GetEnvironmentVariable("PROCESSOR_ARCHITECTURE", "Process")
}
if ([string]::IsNullOrWhiteSpace($architecture)) {
  $architecture = [string][System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
}
$target = switch ($architecture) {
  "AMD64" { "windows-x64"; break }
  "X64" { "windows-x64"; break }
  default { throw "Windows $architecture 빌드는 아직 제공되지 않습니다. 현재는 Windows x64를 지원합니다." }
}

$assetName = "yt2sheet-$target.zip"
$baseUrl = if (-not [string]::IsNullOrWhiteSpace($env:YT2SHEET_RELEASE_BASE_URL)) {
  $env:YT2SHEET_RELEASE_BASE_URL
} elseif (-not [string]::IsNullOrWhiteSpace($ReleaseTag)) {
  "https://github.com/$Repository/releases/download/$ReleaseTag"
} else {
  "https://github.com/$Repository/releases/latest/download"
}
if ([string]::IsNullOrWhiteSpace($baseUrl)) {
  throw "Release download URL is empty. Set YT2SHEET_RELEASE_BASE_URL or provide a repository and release tag."
}
$baseUrl = $baseUrl -replace "/+$", ""
$progressState = [pscustomobject]@{
  CurrentStep = 0
  TotalSteps = 7
}
function Write-InstallStep {
  param(
    [string]$Message,
    [psobject]$ProgressState
  )

  $ProgressState.CurrentStep += 1
  $percent = [Math]::Round(($ProgressState.CurrentStep / $ProgressState.TotalSteps) * 100)
  Write-Output ("### [{0}/{1}] {2} ({3}%)" -f $ProgressState.CurrentStep, $ProgressState.TotalSteps, $Message, $percent)
}
function Download-InstallFile {
  param(
    [string]$Uri,
    [string]$Destination
  )

  $client = $null
  try {
    $client = [System.Net.WebClient]::new()
    if ($null -eq $client) {
      throw "Unable to create the Windows download client."
    }
    $client.DownloadFile($Uri, $Destination)
  }
  finally {
    if ($null -ne $client) {
      $client.Dispose()
    }
  }
}
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("yt2sheet-install-{0:N}" -f [guid]::NewGuid())
$archivePath = Join-Path $temporaryRoot $assetName
$checksumsPath = Join-Path $temporaryRoot "checksums.txt"
$installParent = Split-Path -Parent $InstallRoot
if ([string]::IsNullOrWhiteSpace($installParent)) {
  throw "InstallRoot must have a parent directory: $InstallRoot"
}
New-Item -ItemType Directory -Path $installParent -Force | Out-Null
$stagingRoot = Join-Path $installParent (".yt2sheet-installing-{0:N}" -f [guid]::NewGuid())
$backupRoot = Join-Path $installParent (".yt2sheet-backup-{0:N}" -f [guid]::NewGuid())
$backedUp = $false
$swapped = $false
$installed = $false

try {
  New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
  Write-InstallStep -Message "yt2 번들 다운로드 중" -ProgressState $progressState
  Download-InstallFile -Uri "$baseUrl/$assetName" -Destination $archivePath
  Write-InstallStep -Message "무결성 파일 다운로드 중" -ProgressState $progressState
  Download-InstallFile -Uri "$baseUrl/checksums.txt" -Destination $checksumsPath

  Write-InstallStep -Message "SHA-256 검증 중" -ProgressState $progressState
  $checksumLine = Get-Content -LiteralPath $checksumsPath | Where-Object {
    $_ -match "^\s*[0-9a-fA-F]{64}\s+\*?(?:release-assets/)?$([regex]::Escape($assetName))\s*$"
  } | Select-Object -First 1
  if ([string]::IsNullOrWhiteSpace($checksumLine)) {
    throw "checksums.txt에서 $assetName 항목을 찾지 못했습니다."
  }

  $expectedHash = ([regex]::Match($checksumLine, "^\s*([0-9a-fA-F]{64})")).Groups[1].Value.ToLowerInvariant()
  $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($expectedHash -ne $actualHash) {
    throw "다운로드한 파일의 SHA-256 검증에 실패했습니다."
  }

  $requiredBytes = (Get-Item -LiteralPath $archivePath).Length * 4
  $installVolume = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($InstallRoot))
  if ([string]::IsNullOrWhiteSpace($installVolume)) {
    throw "InstallRoot volume is not available: $InstallRoot"
  }
  $availableBytes = ([System.IO.DriveInfo]::new($installVolume)).AvailableFreeSpace
  if ($availableBytes -lt $requiredBytes) {
    throw "설치 디스크 용량이 부족합니다. 필요: $requiredBytes bytes"
  }

  Write-InstallStep -Message "압축 해제 중" -ProgressState $progressState
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $directorySeparator = [string][System.IO.Path]::DirectorySeparatorChar
  $stagingFullPath = [System.IO.Path]::GetFullPath($stagingRoot).TrimEnd($directorySeparator)
  $stagingBoundary = $stagingFullPath + $directorySeparator
  $zip = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
  try {
    foreach ($entry in $zip.Entries) {
      $destination = [System.IO.Path]::GetFullPath((Join-Path $stagingRoot $entry.FullName))
      if ($destination -ine $stagingFullPath -and -not $destination.StartsWith($stagingBoundary, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "안전하지 않은 아카이브 경로를 거부했습니다: $($entry.FullName)"
      }
    }
  }
  finally {
    $zip.Dispose()
  }
  Expand-Archive -LiteralPath $archivePath -DestinationPath $stagingRoot -Force
  $requiredBundlePaths = @(
    "runtime/node.exe", "app/dist-cli/cli/index.js", "bin/yt2.cmd", "tools/yt-dlp.exe",
    "tools/audiveris", "tools/musescore", "tools/score-runtime-inventory.json", "THIRD_PARTY",
    "VERSION", "THIRD_PARTY_NOTICES.md", "bom.cdx.json", "SOURCE_MANIFEST.json", "COMPLIANCE_SUMMARY.json"
  )
  foreach ($requiredPath in $requiredBundlePaths) {
    if (-not (Test-Path -LiteralPath (Join-Path $stagingRoot $requiredPath))) {
      throw "완전하지 않은 yt2 번들입니다: $requiredPath"
    }
  }
  $runtimeNode = Join-Path $stagingRoot "runtime/node.exe"
  $bundleValidator = @'
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),child=require("node:child_process");
const [root,target]=process.argv.slice(1), fail=(message)=>{throw new Error(`invalid yt2sheet bundle: ${message}`)};
const read=(name)=>fs.readFileSync(path.join(root,name)), json=(name)=>{try{return JSON.parse(read(name))}catch{return fail(`${name} is not valid JSON`)}};
const hash=(value)=>crypto.createHash("sha256").update(value).digest("hex"), safe=(name)=>{if(typeof name!=="string"||name.startsWith("/")||name.includes("\\")||name.split("/").includes(".."))fail(`unsafe inventory path ${name}`);return path.join(root,...name.split("/"))};
if(target!=="windows-x64")fail(`unsupported target ${target}`);
if(!new RegExp(`^yt2sheet \\d+\\.\\d+\\.\\d+ ${target}\\n?$`).test(read("VERSION").toString("utf8")))fail("VERSION does not match the release target");
const inventory=json("tools/score-runtime-inventory.json");
if(inventory.schemaVersion!=="score-runtime-inventory/1"||inventory.platformId!=="windows-2022-x64"||!Array.isArray(inventory.entries)||inventory.entries.length===0)fail("runtime inventory contract mismatch");
for(const [tool,version,digest] of [["audiveris","5.11.0","5f1b4e96a12c53c7da426814b76e599363c4181e291855996e0a6878dda95f71"],["musescore","4.7.4","64fe70e5cb9ffe159d047d1e88db567bd101f60d36b0de28feb674716929a378"]]){
  const archive=inventory.archives?.[tool]; if(!archive||archive.sha256!==digest||inventory.versionProbes?.[tool]!==version||typeof archive.stagedExecutable!=="string"||!archive.stagedExecutable.startsWith(`tools/${tool}/`))fail(`${tool} manifest mismatch`);
  const executable=safe(archive.stagedExecutable); try{fs.accessSync(executable,fs.constants.X_OK)}catch{fail(`${tool} executable is unavailable`)}
  const probe=child.spawnSync(executable,["--version"],{encoding:"utf8",timeout:120000}); const outputs=[probe.stdout,probe.stderr].map((value)=>String(value??"").replace(/\r\n?/g,"\n").trim()).filter(Boolean);
  if(probe.status!==0||outputs.length!==1||outputs[0]!==version)fail(`${tool} version probe mismatch`);
}
for(const entry of inventory.entries){const item=safe(entry.path);let stats;try{stats=fs.lstatSync(item)}catch{fail(`inventory path missing: ${entry.path}`)}if(entry.type==="file"){if(!stats.isFile()||hash(read(entry.path))!==entry.sha256)fail(`inventory file mismatch: ${entry.path}`)}else if(entry.type==="symlink"){if(!stats.isSymbolicLink()||hash(fs.readlinkSync(item))!==entry.sha256)fail(`inventory symlink mismatch: ${entry.path}`)}else if(entry.type!=="directory"||!stats.isDirectory())fail(`inventory type mismatch: ${entry.path}`)}
const bom=json("bom.cdx.json"),sources=json("SOURCE_MANIFEST.json"),summary=json("COMPLIANCE_SUMMARY.json");
if(bom.bomFormat!=="CycloneDX"||!Array.isArray(bom.components)||bom.components.length===0)fail("SBOM is empty or invalid");
if(sources.schemaVersion!=="yt2sheet-source-manifest/1"||!Array.isArray(sources.sources)||sources.sources.length===0)fail("source manifest is empty or invalid");
if(summary.schemaVersion!=="yt2sheet-compliance-summary/1"||summary.componentCount<1||summary.licenseCount<1)fail("compliance summary is empty or invalid");
for(const name of ["SOURCE_MANIFEST.json","THIRD_PARTY_NOTICES.md","bom.cdx.json"])if(summary.artifacts?.[name]!==hash(read(name)))fail(`compliance artifact hash mismatch: ${name}`);
if(read("THIRD_PARTY_NOTICES.md").toString("utf8").trim().length===0)fail("third-party notices are empty");
const thirdParty=path.join(root,"THIRD_PARTY"), files=[]; (function visit(dir){for(const name of fs.readdirSync(dir)){const item=path.join(dir,name),stats=fs.lstatSync(item);if(stats.isDirectory())visit(item);else if(stats.isFile())files.push(item)}})(thirdParty);
if(files.length===0||files.some((file)=>fs.statSync(file).size===0))fail("third-party license/source files are empty");
process.stdout.write("YT2SHEET_BUNDLE_VALID=1");
'@
  $validationOutput = & $runtimeNode "-e" $bundleValidator $stagingRoot $target
  if ($LASTEXITCODE -ne 0 -or $validationOutput -ne "YT2SHEET_BUNDLE_VALID=1") {
    throw "yt2 번들 런타임/준수 검증에 실패했습니다."
  }
  Write-InstallStep -Message "파일 설치 중" -ProgressState $progressState
  if (Test-Path -LiteralPath $InstallRoot) {
    Move-Item -LiteralPath $InstallRoot -Destination $backupRoot
    $backedUp = $true
  }
  Move-Item -LiteralPath $stagingRoot -Destination $InstallRoot
  $swapped = $true

  Write-InstallStep -Message "사용자 PATH 등록 중" -ProgressState $progressState
  $binPath = Join-Path $InstallRoot "bin"
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $pathEntries = if ([string]::IsNullOrWhiteSpace($userPath)) { @() } else { $userPath -split ";" | Where-Object { $_ } }
  $pathExists = $pathEntries | Where-Object { $_.TrimEnd("\") -ieq $binPath.TrimEnd("\") } | Select-Object -First 1
  if ([string]::IsNullOrWhiteSpace($pathExists)) {
    $newUserPath = if ([string]::IsNullOrWhiteSpace($userPath)) { $binPath } else { "$userPath;$binPath" }
    [Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")
  }

  $env:Path = "$binPath;$env:Path"
  Write-InstallStep -Message "설치 파일 확인 중" -ProgressState $progressState
  $launcherPath = Join-Path $binPath "yt2.cmd"
  if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
    throw "설치된 yt2 실행 파일을 찾지 못했습니다: $launcherPath"
  }

  $installed = $true
  if (Test-Path -LiteralPath $backupRoot) {
    Remove-Item -LiteralPath $backupRoot -Recurse -Force
  }

  Write-Output "yt2 설치 완료: $launcherPath"
  Write-Output ('현재 창에서 바로 실행하려면: & "{0}" "https://www.youtube.com/watch?v=..."' -f $launcherPath)
  Write-Output '도움말을 보려면 새 CMD 또는 PowerShell 창에서 다음을 실행하세요: yt2 help'
  Write-Output '새 CMD 또는 PowerShell 창에서 다음처럼 실행하세요: yt2 "https://www.youtube.com/watch?v=..."'
  Write-Output '삭제하려면: yt2 uninstall'
}
finally {
  if (-not $installed -and ($swapped -or $backedUp)) {
    if ($swapped -and (Test-Path -LiteralPath $InstallRoot)) {
      Remove-Item -LiteralPath $InstallRoot -Recurse -Force
    }
    if ($backedUp -and (Test-Path -LiteralPath $backupRoot)) {
      Move-Item -LiteralPath $backupRoot -Destination $InstallRoot
    }
  }
  if (Test-Path -LiteralPath $stagingRoot) {
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force
  }
  if (Test-Path -LiteralPath $backupRoot) {
    Remove-Item -LiteralPath $backupRoot -Recurse -Force
  }
  if (Test-Path -LiteralPath $temporaryRoot) {
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
  }
}
}

try {
  & $installer -ReleaseTag $ReleaseTag -Repository $Repository -InstallRoot $InstallRoot
}
catch {
  $failure = $_
  $details = @(
    "yt2 installer failed: $($failure.Exception.Message)"
    $failure.InvocationInfo.PositionMessage
    "Stack: $($failure.ScriptStackTrace)"
  ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  [Console]::Error.WriteLine(($details -join [Environment]::NewLine))
  throw
}
