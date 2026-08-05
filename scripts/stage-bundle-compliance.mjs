import { execFile } from "node:child_process";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const requiredEntries = ["COMPLIANCE_SUMMARY.json", "SOURCE_MANIFEST.json", "THIRD_PARTY", "THIRD_PARTY_NOTICES.md", "bom.cdx.json"];

export async function stageBundleCompliance(options) {
  const workRoot = await mkdtemp(join(dirname(options.bundleRoot), ".compliance-build-"));
  const outputRoot = join(workRoot, "output");
  try {
    const argumentsList = [
      options.generatorPath,
      "--runtime-manifest", options.runtimeManifestPath,
      "--package-lock", options.packageLockPath,
      "--platform", options.platformId,
      "--bundle", options.bundleRoot,
      "--output", outputRoot
    ];
    if (options.offline) argumentsList.push("--offline");
    await execFileAsync(options.nodePath ?? process.execPath, argumentsList, { env: { ...process.env, ...options.environment }, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    const entries = (await readdir(outputRoot)).sort();
    if (entries.join("\0") !== requiredEntries.join("\0")) throw new Error("compliance generator output is incomplete or contains unexpected root entries");
    for (const entry of entries) {
      await cp(join(outputRoot, entry), join(options.bundleRoot, entry), { recursive: true, preserveTimestamps: true });
    }
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}
