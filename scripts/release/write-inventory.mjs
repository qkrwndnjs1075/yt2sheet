#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, opendir, readlink, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) values.set(argv[index], argv[index + 1]);
  if (!values.get("--root") || !values.get("--output")) throw new Error("usage: --root <directory> --output <file>");
  return { root: resolve(values.get("--root")), output: resolve(values.get("--output")) };
}

async function hash(path) {
  const digest = createHash("sha256");
  await pipeline(createReadStream(path), digest);
  return digest.digest("hex");
}

async function files(root) {
  const found = [];
  async function visit(relativeDirectory) {
    const directory = await opendir(join(root, relativeDirectory));
    for await (const entry of directory) {
      const relativePath = posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) await visit(relativePath);
      else if (entry.isFile()) found.push(relativePath);
      else if (entry.isSymbolicLink()) found.push({ path: relativePath, type: "symlink", target: await readlink(join(root, relativePath)) });
      else throw new Error(`inventory rejects non-file entry: ${relativePath}`);
    }
  }
  await visit("");
  return found.sort();
}

const { root, output } = parseArgs(process.argv.slice(2));
const entries = [];
for (const entry of await files(root)) {
  if (typeof entry === "string") {
    const absolutePath = join(root, entry);
    entries.push({ path: entry, type: "file", bytes: (await stat(absolutePath)).size, sha256: await hash(absolutePath) });
  } else {
    entries.push({ ...entry, sha256: createHash("sha256").update(entry.target).digest("hex") });
  }
}
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify({ schemaVersion: "yt2sheet-release-inventory/1", root: ".", entries }, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ status: "inventory-written", files: entries.length, output })}\n`);
