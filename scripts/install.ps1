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
$stagingRoot = Join-Path $temporaryRoot "staged"

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

  Write-InstallStep -Message "압축 해제 중" -ProgressState $progressState
  Expand-Archive -LiteralPath $archivePath -DestinationPath $stagingRoot -Force
  Write-InstallStep -Message "파일 설치 중" -ProgressState $progressState
  if (Test-Path -LiteralPath $InstallRoot) {
    Remove-Item -LiteralPath $InstallRoot -Recurse -Force
  }
  New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
  $temporaryVolume = [System.IO.Path]::GetPathRoot($temporaryRoot)
  $installVolume = [System.IO.Path]::GetPathRoot($InstallRoot)
  $sameVolume = -not [string]::IsNullOrWhiteSpace($temporaryVolume) -and $temporaryVolume -ieq $installVolume
  Get-ChildItem -LiteralPath $stagingRoot -Force | ForEach-Object {
    if ($sameVolume) {
      Move-Item -LiteralPath $_.FullName -Destination $InstallRoot -Force
    } else {
      Copy-Item -LiteralPath $_.FullName -Destination $InstallRoot -Recurse -Force
    }
  }

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

  Write-Output "yt2 설치 완료: $launcherPath"
  Write-Output ('현재 창에서 바로 실행하려면: & "{0}" "https://www.youtube.com/watch?v=..."' -f $launcherPath)
  Write-Output '도움말을 보려면 새 CMD 또는 PowerShell 창에서 다음을 실행하세요: yt2 help'
  Write-Output '새 CMD 또는 PowerShell 창에서 다음처럼 실행하세요: yt2 "https://www.youtube.com/watch?v=..."'
  Write-Output '삭제하려면: yt2 uninstall'
}
finally {
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
