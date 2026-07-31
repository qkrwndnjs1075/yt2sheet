import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CliUninstallOptions } from "./uninstall";

export async function removeUnixArtifacts(root: string, options: CliUninstallOptions): Promise<void> {
  const profiles = profilePaths(options);
  const profileDirectories = await readProfileDirectories(profiles);
  const launcherDirectories = uniqueDirectories([
    options.environment.YT2SHEET_BIN_DIR ?? "",
    join(options.homeDirectory, ".local", "bin"),
    ...splitPath(options.environment.PATH, options.platform),
    ...profileDirectories
  ]);
  const launcherTarget = await realPathIfPresent(join(root, "bin", "yt2"));
  const ownedLauncherDirectories = launcherTarget
    ? await findOwnedLauncherDirectories(launcherDirectories, launcherTarget, options.platform)
    : [];

  for (const directory of ownedLauncherDirectories) {
    await rm(join(directory, "yt2"), { force: true });
  }
  for (const profile of profiles) {
    await removeInstallerProfileLines(profile, ownedLauncherDirectories, options.platform);
  }
  await rm(root, { recursive: true, force: true });
}

export async function scheduleWindowsCleanup(root: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const scriptPath = join(tmpdir(), `yt2sheet-uninstall-${randomUUID()}.ps1`);
  await writeFile(scriptPath, buildWindowsCleanupScript(), "utf8");

  try {
    await new Promise<void>((resolveDone, rejectDone) => {
      try {
        const child = spawn(
          "cmd.exe",
          [
            "/d",
            "/c",
            "start",
            "\"\"",
            "/b",
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-File",
            scriptPath
          ],
          {
            detached: true,
            windowsHide: true,
            stdio: "ignore",
            env: {
              ...environment,
              YT2SHEET_UNINSTALL_ROOT: root
            }
          }
        );
        child.once("error", rejectDone);
        child.once("spawn", () => {
          child.unref();
          resolveDone();
        });
      } catch (error: unknown) {
        rejectDone(error);
      }
    });
  } catch (error: unknown) {
    await rm(scriptPath, { force: true });
    throw error;
  }
}

function buildWindowsCleanupScript(): string {
  return [
    "$root = [Environment]::GetEnvironmentVariable('YT2SHEET_UNINSTALL_ROOT', 'Process')",
    "$bin = [System.IO.Path]::Combine($root, 'bin')",
    "Start-Sleep -Milliseconds 500",
    "$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')",
    "if ($null -ne $userPath) { $pathEntries = @($userPath -split ';' | Where-Object { $_ }); $entries = @($pathEntries | Where-Object { $_.Trim().TrimEnd([char]92) -ine $bin.TrimEnd([char]92) }); if ($entries.Count -ne $pathEntries.Count) { [Environment]::SetEnvironmentVariable('Path', ($entries -join ';'), 'User') } }",
    "$attempt = 0",
    "try { while ((Test-Path -LiteralPath $root) -and $attempt -lt 120) { try { $quotedRoot = '\"' + $root + '\"'; & cmd.exe /d /c \"rmdir /s /q $quotedRoot\"; if ($LASTEXITCODE -ne 0) { throw \"rmdir exited with code $LASTEXITCODE\" } } catch { Start-Sleep -Milliseconds 250; $attempt += 1 } } } finally { Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue }"
  ].join("\r\n");
}

function profilePaths(options: CliUninstallOptions): readonly string[] {
  const configuredProfile = options.environment.YT2SHEET_PROFILE?.trim();
  if (configuredProfile) {
    return [resolve(configuredProfile)];
  }
  return uniqueDirectories([
    join(options.homeDirectory, ".profile"),
    join(options.homeDirectory, ".zprofile")
  ]);
}

async function readProfileDirectories(profiles: readonly string[]): Promise<readonly string[]> {
  const directories: string[] = [];
  for (const profile of profiles) {
    const contents = await readOptionalFile(profile);
    if (contents === null) {
      continue;
    }
    for (const line of contents.split(/\r?\n/)) {
      const match = /^export PATH="(.+):\$PATH"$/.exec(line);
      if (match?.[1]) {
        directories.push(match[1]);
      }
    }
  }
  return directories;
}

function splitPath(pathValue: string | undefined, platform: NodeJS.Platform): readonly string[] {
  if (!pathValue) {
    return [];
  }
  const separator = platform === "win32" ? ";" : ":";
  return pathValue.split(separator).filter((entry) => entry.trim());
}

function uniqueDirectories(directories: readonly string[]): readonly string[] {
  const unique = new Set<string>();
  for (const directory of directories) {
    if (directory.trim()) {
      unique.add(resolve(directory.trim()));
    }
  }
  return [...unique];
}

async function findOwnedLauncherDirectories(
  directories: readonly string[],
  target: string,
  platform: NodeJS.Platform
): Promise<readonly string[]> {
  const owned: string[] = [];
  for (const directory of directories) {
    const launcher = join(directory, "yt2");
    try {
      const stats = await lstat(launcher);
      if (!stats.isSymbolicLink()) {
        continue;
      }
      const actualTarget = await realpath(launcher);
      if (samePath(actualTarget, target, platform)) {
        owned.push(directory);
      }
    } catch (error: unknown) {
      if (!isMissingPath(error)) {
        throw error;
      }
    }
  }
  return owned;
}

async function removeInstallerProfileLines(
  profile: string,
  ownedDirectories: readonly string[],
  platform: NodeJS.Platform
): Promise<void> {
  const contents = await readOptionalFile(profile);
  if (contents === null || ownedDirectories.length === 0) {
    return;
  }

  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  const lines = contents.split(/\r?\n/);
  const retainedLines = lines.filter((line) => {
    const match = /^export PATH="(.+):\$PATH"$/.exec(line);
    return !match?.[1] || !ownedDirectories.some((directory) => samePath(resolve(match[1]), directory, platform));
  });
  if (retainedLines.length !== lines.length) {
    await writeFile(profile, retainedLines.join(newline), "utf8");
  }
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isMissingPath(error)) {
      return null;
    }
    throw error;
  }
}

async function realPathIfPresent(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (error: unknown) {
    if (isMissingPath(error)) {
      return null;
    }
    throw error;
  }
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
