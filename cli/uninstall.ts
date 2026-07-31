import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { removeUnixArtifacts, scheduleWindowsCleanup } from "./uninstall-cleanup";

export type CliUninstallOptions = Readonly<{
  readonly entryPoint: string;
  readonly platform: NodeJS.Platform;
  readonly environment: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
}>;

export type CliUninstallOutcome =
  | { readonly kind: "removed"; readonly installRoot: string; readonly deferred: boolean }
  | { readonly kind: "npm"; readonly command: "npm uninstall -g yt2sheet" };

const requiredInstallDirectories: readonly string[] = ["runtime", "app", "bin", "tools"];
const npmUninstallCommand = "npm uninstall -g yt2sheet";

export async function uninstallStandaloneCli(
  options: CliUninstallOptions = defaultOptions()
): Promise<CliUninstallOutcome> {
  const installRoot = await findStandaloneInstallRoot(options);
  if (!installRoot) {
    return { kind: "npm", command: npmUninstallCommand };
  }

  if (options.platform === "win32") {
    await scheduleWindowsCleanup(installRoot, options.environment);
    return { kind: "removed", installRoot, deferred: true };
  }

  await removeUnixArtifacts(installRoot, options);
  return { kind: "removed", installRoot, deferred: false };
}

export function formatCliUninstallOutcome(outcome: CliUninstallOutcome): string {
  switch (outcome.kind) {
    case "removed":
      return outcome.deferred
        ? "yt2 uninstall scheduled. Close this terminal and open a new one after cleanup.\n"
        : "yt2 standalone installation removed. Open a new terminal to refresh PATH.\n";
    case "npm":
      return `This yt2 command is managed by npm.\nRun:\n  ${outcome.command}\n`;
    default:
      return assertNever(outcome);
  }
}

function defaultOptions(): CliUninstallOptions {
  return {
    entryPoint: process.argv[1] ?? "",
    platform: process.platform,
    environment: process.env,
    homeDirectory: homedir()
  };
}

async function findStandaloneInstallRoot(options: CliUninstallOptions): Promise<string | null> {
  const configuredRoot = options.environment.YT2SHEET_ROOT?.trim();
  const candidate = configuredRoot
    ? resolve(configuredRoot)
    : deriveInstallRoot(options.entryPoint);
  if (!candidate || !(await isOwnedStandaloneRoot(candidate))) {
    return null;
  }
  return candidate;
}

function deriveInstallRoot(entryPoint: string): string | null {
  if (!entryPoint.trim()) {
    return null;
  }
  return resolve(dirname(entryPoint), "..", "..", "..");
}

async function isOwnedStandaloneRoot(root: string): Promise<boolean> {
  try {
    const rootStats = await lstat(root);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      return false;
    }

    const version = (await readFile(join(root, "VERSION"), "utf8")).trim();
    if (!version.startsWith("yt2sheet ")) {
      return false;
    }

    for (const directory of requiredInstallDirectories) {
      const stats = await lstat(join(root, directory));
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        return false;
      }
    }
    return true;
  } catch (error: unknown) {
    if (isMissingPath(error)) {
      return false;
    }
    throw error;
  }
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function assertNever(value: never): never {
  throw new Error(`Unhandled uninstall outcome: ${String(value)}`);
}
