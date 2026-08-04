#!/usr/bin/env node

import { generateKeyPairSync, sign } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { sha256, verifyReleaseCandidate } from "./release-candidate-verifier.mjs";

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) values.set(argv[index], argv[index + 1]);
  for (const name of ["--candidate-root", "--package-json", "--publication-dir"]) {
    if (!values.get(name)) throw new Error(`missing ${name}`);
  }
  const maximum = Number(values.get("--max-total-bytes") ?? "6442450944");
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 6442450944) throw new Error("invalid --max-total-bytes");
  return {
    candidateRoot: resolve(values.get("--candidate-root")),
    packageJson: resolve(values.get("--package-json")),
    publicationDir: resolve(values.get("--publication-dir")),
    maximum
  };
}

const ASSET_KINDS = Object.freeze({
  "yt2sheet-windows-x64.zip": "runtime-windows-x64",
  "yt2sheet-darwin-x64.tar.gz": "runtime-darwin-x64",
  "yt2sheet-darwin-arm64.tar.gz": "runtime-darwin-arm64",
  "yt2sheet-linux-x64.tar.gz": "runtime-ubuntu22-x64",
  "score-runtime-manifest.json": "runtime-manifest",
  "musicxml-4.0-schema.tar.gz": "musicxml-schema",
  "THIRD_PARTY_NOTICES.md": "license",
  "bom.cdx.json": "sbom",
  "third-party-sources.tar.gz": "source",
  "SOURCE_MANIFEST.json": "source-manifest",
  "release-inventory.json": "inventory"
});

async function fact(path, kind, root) {
  const bytes = await readFile(join(root, "assets", path));
  return { kind, path: `assets/${path}`, sha256: sha256(bytes), size: bytes.byteLength };
}

const args = parseArgs(process.argv.slice(2));
const assetsRoot = join(args.candidateRoot, "assets");
await rm(join(assetsRoot, "release-inventory.json"), { force: true });
const originalNames = (await readdir(assetsRoot)).sort();
const expectedOriginalNames = Object.keys(ASSET_KINDS).filter((name) => name !== "release-inventory.json").sort();
if (JSON.stringify(originalNames) !== JSON.stringify(expectedOriginalNames)) {
  throw new Error(`compliance-inventory: exact candidate assets required; found ${originalNames.join(",")}`);
}
const originalFacts = await Promise.all(originalNames.map((name) => fact(name, ASSET_KINDS[name], args.candidateRoot)));
await writeFile(join(assetsRoot, "release-inventory.json"), `${JSON.stringify({
  schemaVersion: "yt2sheet-release-inventory/1",
  assets: originalFacts.map(({ path, ...entry }) => ({ ...entry, path: basename(path) }))
}, null, 2)}\n`, "utf8");
const facts = await Promise.all(Object.entries(ASSET_KINDS).map(([name, kind]) => fact(name, kind, args.candidateRoot)));
const checksumBytes = Buffer.from(`${facts.map(({ sha256: digest, path }) => `${digest}  ${basename(path)}`).sort().join("\n")}\n`);
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicPem = publicKey.export({ type: "spki", format: "pem" });
const packageMetadata = JSON.parse(await readFile(args.packageJson, "utf8"));
await Promise.all([
  writeFile(join(args.candidateRoot, "package.json"), `${JSON.stringify({ name: packageMetadata.name, version: packageMetadata.version }, null, 2)}\n`, "utf8"),
  writeFile(join(args.candidateRoot, "checksums.txt"), checksumBytes),
  writeFile(join(args.candidateRoot, "checksums.pub"), publicPem),
  writeFile(join(args.candidateRoot, "checksums.sig"), `${sign(null, checksumBytes, privateKey).toString("base64")}\n`, "utf8"),
  writeFile(join(args.candidateRoot, "candidate-manifest.json"), `${JSON.stringify({
    schemaVersion: "yt2sheet-release-candidate/1",
    version: packageMetadata.version,
    maxTotalBytes: args.maximum,
    maxAssetBytes: 2147483648,
    signingPublicKeySha256: sha256(publicPem),
    assets: facts
  }, null, 2)}\n`, "utf8")
]);
await verifyReleaseCandidate({ fixtureDir: args.candidateRoot, candidateDir: args.publicationDir });
for (const name of await readdir(assetsRoot)) await cp(join(assetsRoot, name), join(args.publicationDir, name));
for (const name of ["checksums.txt", "checksums.sig", "checksums.pub", "candidate-manifest.json"]) {
  await cp(join(args.candidateRoot, name), join(args.publicationDir, basename(name)));
}
process.stdout.write(`${JSON.stringify({ gate: "candidate-commit", publicationDir: args.publicationDir, assets: facts.length })}\n`);
