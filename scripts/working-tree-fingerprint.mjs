import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { resolve, sep } from "node:path";

const ABSENT = "ABSENT";
const excludedDirectories = new Set([".git", "build-test", "dist", "evidence"]);
const root = parseRoot(process.argv.slice(2));
const entries = fingerprintEntries(root);
const manifest = {
  entries,
  sha256: sha256(JSON.stringify(entries)),
  version: 1
};

process.stdout.write(`${JSON.stringify(manifest)}\n`);

function parseRoot(args) {
  if (args.length === 0) {
    return process.cwd();
  }
  if (args.length === 2 && args[0] === "--root") {
    return resolve(args[1]);
  }
  throw new Error("Usage: node scripts/working-tree-fingerprint.mjs [--root <directory>]");
}

function fingerprintEntries(workingRoot) {
  const tracked = gitNulList(workingRoot, ["ls-files", "--cached", "--stage", "-z"])
    .map(parseTrackedEntry)
    .filter((entry) => entry.stage === "0" && isIncluded(entry.path))
    .map((entry) => fingerprintPath(workingRoot, entry.path, "tracked", entry.mode));
  const untracked = gitNulList(workingRoot, ["ls-files", "--others", "--exclude-standard", "-z"])
    .filter(isIncluded)
    .map((path) => fingerprintPath(workingRoot, path, "untracked"));
  return [...tracked, ...untracked].sort(comparePaths);
}

function gitNulList(workingRoot, args) {
  const result = spawnSync("git", args, { cwd: workingRoot, encoding: "buffer" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.toString("utf8").trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry.length > 0);
}

function parseTrackedEntry(entry) {
  const tabIndex = entry.indexOf("\t");
  if (tabIndex === -1) {
    throw new Error("Git returned an invalid cached-path entry.");
  }
  const [mode, , stage] = entry.slice(0, tabIndex).split(" ");
  if (!mode || !stage) {
    throw new Error("Git returned an invalid cached-path metadata entry.");
  }
  return { mode, path: entry.slice(tabIndex + 1), stage };
}

function isIncluded(path) {
  const segments = path.split(/[\\/]/);
  return !segments.some((segment, index) => {
    if (excludedDirectories.has(segment)) {
      return true;
    }
    return index > 0 && segments[index - 1] === ".omo" && segment === "evidence";
  });
}

function fingerprintPath(workingRoot, relativePath, status, trackedMode) {
  const fullPath = resolve(workingRoot, ...relativePath.split("/"));
  const stat = lstatOrAbsent(fullPath);
  if (stat === null) {
    return { mode: trackedMode ?? ABSENT, path: relativePath, sha256: ABSENT, status, type: "absent" };
  }
  const mode = trackedMode ?? fileMode(stat);
  if (stat.isSymbolicLink()) {
    return { mode, path: relativePath, sha256: sha256(readlinkSync(fullPath, "buffer")), status, type: "symlink" };
  }
  if (stat.isDirectory()) {
    return { mode, path: relativePath, sha256: ABSENT, status, type: "directory" };
  }
  return { mode, path: relativePath, sha256: sha256(readFileSync(fullPath)), status, type: "file" };
}

function lstatOrAbsent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function fileMode(stat) {
  const permissions = (stat.mode & 0o777).toString(8).padStart(3, "0");
  return `${stat.isSymbolicLink() ? "120" : stat.isDirectory() ? "040" : "100"}${permissions}`;
}

function comparePaths(left, right) {
  if (left.path < right.path) {
    return -1;
  }
  if (left.path > right.path) {
    return 1;
  }
  return 0;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
