import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const outputRoot = resolve(projectRoot, "dist-cli");
const typeScriptEntry = resolve(projectRoot, "node_modules/typescript/bin/tsc");

await rm(outputRoot, { recursive: true, force: true });
execFileSync(process.execPath, [typeScriptEntry, "-p", resolve(projectRoot, "tsconfig.cli.json")], {
  cwd: projectRoot,
  stdio: "inherit"
});
await mkdir(outputRoot, { recursive: true });
await writeFile(resolve(outputRoot, "package.json"), `${JSON.stringify({ type: "commonjs" })}\n`, "utf8");
