#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) values.set(argv[index], argv[index + 1]);
  for (const name of ["--candidate-root", "--gate", "--receipt", "--facts-file", "--evidence"]) {
    if (!values.get(name)) throw new Error(`missing ${name}`);
  }
  return {
    candidateRoot: resolve(values.get("--candidate-root")),
    gate: values.get("--gate"),
    receipt: resolve(values.get("--receipt")),
    factsFile: resolve(values.get("--facts-file")),
    evidence: values.get("--evidence").split(",").map((path) => resolve(path))
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const args = parseArgs(process.argv.slice(2));
const facts = JSON.parse(await readFile(args.factsFile, "utf8"));
const evidence = await Promise.all(args.evidence.map(async (path) => {
  const bytes = await readFile(path);
  const evidencePath = relative(args.candidateRoot, path).split(sep).join("/");
  if (evidencePath.startsWith("../") || evidencePath === "..") throw new Error(`evidence must be below candidate root: ${path}`);
  return { path: evidencePath, sha256: sha256(bytes), size: bytes.byteLength };
}));
await mkdir(dirname(args.receipt), { recursive: true });
await writeFile(args.receipt, `${JSON.stringify({
  schemaVersion: "yt2sheet-release-gate-receipt/1",
  gate: args.gate,
  exitCode: 0,
  evidence,
  facts
}, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ gate: args.gate, evidence: evidence.length })}\n`);
