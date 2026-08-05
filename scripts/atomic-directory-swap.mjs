import { access, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export async function replaceDirectory(stagedRoot, outputRoot) {
  const target = resolve(outputRoot);
  const backupRoot = await mkdtemp(join(dirname(target), ".bundle-backup-"));
  const priorOutput = join(backupRoot, "output");
  let hadPriorOutput = false;
  try {
    try {
      await access(target);
      await rename(target, priorOutput);
      hadPriorOutput = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    try {
      await rename(stagedRoot, target);
    } catch (error) {
      if (hadPriorOutput) await rename(priorOutput, target);
      throw error;
    }
  } finally {
    await rm(backupRoot, { recursive: true, force: true });
  }
}
