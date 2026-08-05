import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

function tar(root, args, gate) {
  const result = spawnSync("tar", args, { cwd: root, encoding: null, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${gate}: unable to inspect archive-derived compliance bytes`);
  return result.stdout;
}

function normalizeEntry(path) {
  return path.replace(/^\.\//u, "").replace(/\/$/u, "");
}

function fileEntries(root, archive, prefix, gate) {
  return tar(root, ["-tzf", archive], gate).toString("utf8").split(/\r?\n/u).filter((path) => path && !path.endsWith("/"))
    .map(normalizeEntry).filter((path) => path.startsWith(prefix) && path !== prefix);
}

function archiveBytes(root, archive, path, gate) {
  const entry = tar(root, ["-tzf", archive], gate).toString("utf8").split(/\r?\n/u).find((candidate) => normalizeEntry(candidate) === path);
  if (!entry) throw new Error(`${gate}: archive entry is missing: ${path}`);
  return tar(root, ["-xOf", archive, entry], gate);
}

async function requireEqual(actual, expected, gate, detail) {
  if (!Buffer.from(actual).equals(Buffer.from(expected))) throw new Error(`${gate}: ${detail}`);
}

async function compareTree(root, candidateArchive, candidatePrefix, runtimeArchive, runtimePrefix, gate) {
  const candidateEntries = fileEntries(root, candidateArchive, candidatePrefix, gate);
  const runtimeEntries = fileEntries(root, runtimeArchive, runtimePrefix, gate);
  const candidateRelative = candidateEntries.map((path) => path.slice(candidatePrefix.length)).sort();
  const runtimeRelative = runtimeEntries.map((path) => path.slice(runtimePrefix.length)).sort();
  if (JSON.stringify(candidateRelative) !== JSON.stringify(runtimeRelative)) throw new Error(`${gate}: archive-derived directory inventory mismatch`);
  for (const suffix of candidateRelative) {
    await requireEqual(
      archiveBytes(root, candidateArchive, `${candidatePrefix}${suffix}`, gate),
      archiveBytes(root, runtimeArchive, `${runtimePrefix}${suffix}`, gate),
      gate,
      `archive-derived bytes differ: ${candidatePrefix}${suffix}`
    );
  }
}

export async function verifyArchiveDerivedCompliance(root) {
  const gate = "archive-derived-compliance";
  const runtimeArchive = "assets/yt2sheet-linux-x64.tar.gz";
  const direct = [
    ["assets/THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"],
    ["assets/bom.cdx.json", "bom.cdx.json"],
    ["assets/SOURCE_MANIFEST.json", "SOURCE_MANIFEST.json"],
    ["assets/score-runtime-manifest.json", "scripts/score-runtime-manifest.json"]
  ];
  for (const [candidatePath, runtimePath] of direct) {
    await requireEqual(await readFile(join(root, candidatePath)), archiveBytes(root, runtimeArchive, runtimePath, gate), gate, `${candidatePath} differs from the verified runtime archive`);
  }
  await compareTree(root, "assets/third-party-sources.tar.gz", "THIRD_PARTY/sources", runtimeArchive, "THIRD_PARTY/sources", gate);
  await compareTree(root, "assets/musicxml-4.0-schema.tar.gz", "musicxml-4.0", runtimeArchive, "vendor/musicxml-4.0", gate);
}
