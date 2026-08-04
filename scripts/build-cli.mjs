import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const outputRoot = resolve(projectRoot, "dist-cli");
const typeScriptEntry = resolve(projectRoot, "node_modules/typescript/bin/tsc");
const packageMetadata = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));

await rm(outputRoot, { recursive: true, force: true });
execFileSync(process.execPath, [typeScriptEntry, "-p", resolve(projectRoot, "tsconfig.cli.json")], {
  cwd: projectRoot,
  stdio: "inherit"
});
await mkdir(outputRoot, { recursive: true });
await writeFile(
  resolve(outputRoot, "package.json"),
  `${JSON.stringify({ type: "commonjs", name: packageMetadata.name, version: packageMetadata.version })}\n`,
  "utf8"
);
