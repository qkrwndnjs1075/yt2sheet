import { cp, mkdir } from "node:fs/promises";
import { basename, dirname, posix, relative, resolve, sep } from "node:path";
import { verifiedArchive } from "./score-runtime-staging-io.mjs";

function text(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function relativePath(value, label) {
  const path = text(value, label);
  if (path.startsWith("/") || path.includes("\\") || posix.normalize(path) !== path || path.split("/").includes("..")) throw new Error(`${label} must be bundle-relative`);
  return path;
}

function fontRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid pinned score font record");
  const font = value;
  const assetName = text(font.assetName, "score font assetName");
  if (basename(assetName) !== assetName) throw new Error("score font assetName contains traversal");
  const url = text(font.url, "score font URL");
  if (new URL(url).protocol !== "https:") throw new Error("score font URL must use HTTPS");
  const sha256 = text(font.sha256, "score font SHA-256");
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("score font SHA-256 is invalid");
  return { assetName, bundledPath: relativePath(font.bundledPath, "score font bundledPath"), url, sha256 };
}

export async function stageDeclaredFonts(input) {
  const fonts = input.manifest?.tools?.musescore?.fonts;
  if (fonts === undefined) return;
  if (!Array.isArray(fonts)) throw new Error("score font records must be an array");
  const boundary = resolve(input.stageRoot);
  for (const rawFont of fonts) {
    const font = fontRecord(rawFont);
    const destination = resolve(boundary, font.bundledPath, font.assetName);
    const escape = relative(boundary, destination);
    if (escape === ".." || escape.startsWith(`..${sep}`)) throw new Error("score font destination escapes bundle");
    const archive = await verifiedArchive(font, input.options);
    await mkdir(dirname(destination), { recursive: true });
    await cp(archive, destination, { force: true, preserveTimestamps: true });
  }
}
