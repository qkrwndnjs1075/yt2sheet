import { spawn } from "node:child_process";
import { lstat, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CliUninstallOptions } from "./uninstall";

export async function removeStandaloneArtifacts(root: string, options: CliUninstallOptions): Promise<void> {
  if (options.platform === "win32") {
    await removeWindowsPathEntry(join(root, "bin"), options.environment);
    if (options.environment.YT2SHEET_UNINSTALL_HANDOFF !== "launcher") {
      await rm(root, { recursive: true, force: true });
    }
    return;
  }

  await removeUnixArtifacts(root, options);
}

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

async function removeWindowsPathEntry(binDirectory: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", buildWindowsPathCleanupCommand()],
    {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...environment,
        YT2SHEET_UNINSTALL_BIN: binDirectory
      }
    }
  );
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  await new Promise<void>((resolveDone, rejectDone) => {
    child.once("error", rejectDone);
    child.once("close", (code) => {
      if (code === 0) {
        resolveDone();
        return;
      }
      const details = stderr.trim();
      rejectDone(new Error(`Windows PATH cleanup failed with exit code ${String(code)}${details ? `: ${details}` : ""}`));
    });
  });
}

function buildWindowsPathCleanupCommand(): string {
  return [
    "$bin = [Environment]::GetEnvironmentVariable('YT2SHEET_UNINSTALL_BIN', 'Process')",
    "if ([string]::IsNullOrWhiteSpace($bin)) { throw 'Standalone bin path is missing.' }",
    "$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')",
    "if (-not [string]::IsNullOrWhiteSpace($userPath)) { $entries = @($userPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }); $retained = @($entries | Where-Object { $_.TrimEnd([char]92) -ine $bin.TrimEnd([char]92) }); if ($retained.Count -ne $entries.Count) { [Environment]::SetEnvironmentVariable('Path', ($retained -join ';'), 'User') } }"
  ].join(";");
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
