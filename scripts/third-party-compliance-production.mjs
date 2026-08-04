import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, cp, mkdir, opendir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import { basename, dirname, join, posix, relative, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fail } from "./third-party-compliance-manifest.mjs";

const SOURCE_LIMIT = 1024 * 1024 * 1024;
const TEXT_LIMIT = 4 * 1024 * 1024;
const NOTICE_NAMES = /^(?:assembly_exception|copying|legal|license|notice|third[_-]?party)(?:[._-].*)?$/i;
const PINNED_TOOLS = Object.freeze({
  audiveris: Object.freeze({ version: "5.11.0", tag: "5.11.0", commit: "9e1e55cd2746037d059345881c53e6a6754bffbd" }),
  musescore: Object.freeze({ version: "4.7.4", tag: "v4.7.4", commit: "7688c005ad963ba09ee715aae53dbc7e8c9d5ef8" })
});
const PINNED_LICENSE_HASHES = new Map([
  ["https://raw.githubusercontent.com/Audiveris/audiveris/9e1e55cd2746037d059345881c53e6a6754bffbd/LICENSE", "76a97c878c9c7a8321bb395c2b44d3fe2f8d81314d219b20138ed0e2dddd5182"],
  ["https://raw.githubusercontent.com/musescore/MuseScore/7688c005ad963ba09ee715aae53dbc7e8c9d5ef8/LICENSE.txt", "73e75f61f0dfce4fd83ad1f3f45d1d6f9ea8cdfd21a92d7a9216d47e5b3bbb88"],
  ["https://raw.githubusercontent.com/musescore/MuseScore/7688c005ad963ba09ee715aae53dbc7e8c9d5ef8/fonts/bravura/OFL.txt", "c24929be7028026a65ee8894da1e3c36d2a4ccce0548d9ba8ba64509f46319ee"],
  ["https://raw.githubusercontent.com/musescore/MuseScore/7688c005ad963ba09ee715aae53dbc7e8c9d5ef8/fonts/leland/LICENSE.txt", "eb60b6a7d8c70b05c9fbd6f257e725ec2bc161cc82e78e299a34344ac9c4c1bb"]
]);

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function text(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function safePath(value, label) {
  const path = text(value, label);
  if (path.startsWith("/") || path.includes("\\") || posix.normalize(path) !== path || path.split("/").includes("..")) fail(`${label} must be bundle-relative`);
  return path;
}

async function sha256(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function download(url, destination, limit, redirects = 0) {
  if (redirects > 5) fail(`too many redirects while downloading ${url}`);
  const temporary = `${destination}.part-${process.pid}`;
  await mkdir(dirname(destination), { recursive: true });
  try {
    await new Promise((resolvePromise, reject) => {
      const request = https.get(url, (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
          response.resume();
          if (typeof response.headers.location !== "string") return reject(new Error(`redirect without location: ${url}`));
          return resolvePromise(download(new URL(response.headers.location, url).href, destination, limit, redirects + 1));
        }
        if (response.statusCode !== 200) {
          response.resume();
          return reject(new Error(`download failed with HTTP ${response.statusCode}: ${url}`));
        }
        const advertised = Number(response.headers["content-length"]);
        if (Number.isFinite(advertised) && advertised > limit) {
          response.resume();
          return reject(new Error(`download exceeds ${limit} bytes: ${url}`));
        }
        let received = 0;
        const limiter = new Transform({ transform(chunk, _encoding, callback) {
          received += chunk.length;
          callback(received <= limit ? undefined : new Error(`download exceeds ${limit} bytes: ${url}`), chunk);
        } });
        pipeline(response, limiter, createWriteStream(temporary, { mode: 0o600 })).then(resolvePromise, reject);
      });
      request.on("error", reject);
      request.setTimeout(15 * 60 * 1000, () => request.destroy(new Error(`download timed out: ${url}`)));
    });
    try {
      await access(destination);
      await rm(temporary, { force: true });
    } catch {
      await rename(temporary, destination);
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function materialize(bundle, path, url, limit, offline) {
  const destination = join(bundle, safePath(path, "runtime compliance path"));
  try {
    await access(destination);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    if (offline) fail(`offline compliance input is missing: ${path}`);
    await download(text(url, `source URL for ${path}`), destination, limit);
  }
  const actual = await sha256(destination);
  const expected = PINNED_LICENSE_HASHES.get(url);
  if (expected !== undefined && actual !== expected) fail(`pinned compliance input SHA-256 mismatch: ${path}`);
  return { path, sha256: actual };
}

async function filesBelow(bundle, root) {
  const found = [];
  async function visit(relativeDirectory) {
    const directory = await opendir(join(bundle, relativeDirectory));
    for await (const entry of directory) {
      const path = posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) found.push({ path, sha256: await sha256(join(bundle, path)) });
      else if (entry.isSymbolicLink()) {
        const actual = await realpath(join(bundle, path));
        const escape = relative(bundle, actual);
        if (escape === ".." || escape.startsWith(`..${sep}`)) fail(`staged runtime symlink escapes bundle: ${path}`);
        found.push({ path, sha256: await sha256(join(bundle, path)) });
      }
      else fail(`unsupported staged runtime entry: ${path}`);
    }
  }
  await visit(root);
  return found.sort((left, right) => left.path.localeCompare(right.path));
}

async function materializeNotices(bundle, tool, files) {
  const notices = [];
  for (const file of files) {
    if (!NOTICE_NAMES.test(basename(file.path))) continue;
    const relative = file.path.slice(`tools/${tool}/`.length);
    const outputPath = posix.join("THIRD_PARTY/notices", tool, relative);
    await mkdir(dirname(join(bundle, outputPath)), { recursive: true });
    await cp(join(bundle, file.path), join(bundle, outputPath));
    notices.push({ path: outputPath, sha256: file.sha256 });
  }
  return notices;
}

function platformFor(runtime, platformId) {
  if (runtime.schemaVersion !== "score-runtime-manifest/1") fail("runtime manifest schemaVersion is unsupported");
  const matches = Array.isArray(runtime.platforms) ? runtime.platforms.filter((platform) => platform?.id === platformId) : [];
  if (matches.length !== 1) fail(`runtime manifest platform must resolve exactly once: ${platformId}`);
  return matches[0];
}

function toolRecord(runtime, name) {
  const tool = record(record(runtime.tools, "runtime tools")[name], `runtime tool ${name}`);
  const source = record(tool.source, `runtime tool ${name}.source`);
  const license = record(tool.license, `runtime tool ${name}.license`);
  const commit = text(tool.commit, `runtime tool ${name}.commit`);
  const pinned = PINNED_TOOLS[name];
  if (tool.version !== pinned.version || tool.tag !== pinned.tag || commit !== pinned.commit) fail(`${name}: unpinned tool version, tag, or commit`);
  if (!/^[a-f0-9]{40}$/.test(commit) || source.commit !== commit || !text(source.archiveUrl, `${name}.archiveUrl`).includes(commit) || !text(license.sourceUrl, `${name}.licenseUrl`).includes(commit)) fail(`${name}: runtime source and license must use its pinned commit`);
  return { name, displayName: name === "audiveris" ? "Audiveris" : "MuseScore", version: text(tool.version, `${name}.version`), tag: text(tool.tag, `${name}.tag`), commit, source, license, fonts: Array.isArray(tool.fonts) ? tool.fonts : [] };
}

export async function deriveProductionManifest(input) {
  const runtime = record(input.runtimeManifest, "runtime manifest");
  const packageRoot = record(record(record(input.packageLock, "package-lock").packages, "package-lock packages")[""], "package-lock root");
  const platform = platformFor(runtime, input.platformId);
  const tools = [toolRecord(runtime, "audiveris"), toolRecord(runtime, "musescore")];
  const components = [];
  const fontComponents = [];
  for (const tool of tools) {
    const toolRoot = `tools/${tool.name}`;
    const allFiles = await filesBelow(input.bundle, toolRoot);
    const runtimeAsset = record(record(platform.runtimes, "runtime platform runtimes")[tool.name], `runtime asset ${tool.name}`);
    const versionProbe = record(runtimeAsset.versionProbe, `runtime asset ${tool.name}.versionProbe`);
    if (versionProbe.expected !== PINNED_TOOLS[tool.name].version) fail(`${tool.name}: unpinned runtime version probe`);
    const fontRoots = tool.fonts.map((font) => safePath(font.bundledPath, `${font.family}.bundledPath`));
    const toolFiles = allFiles.filter((file) => !fontRoots.some((root) => file.path === root || file.path.startsWith(`${root}/`)));
    if (toolFiles.length === 0) fail(`${tool.displayName}: staged runtime files are missing`);
    const license = await materialize(input.bundle, tool.license.bundledPath, tool.license.sourceUrl, TEXT_LIMIT, input.offline);
    const source = await materialize(input.bundle, tool.source.bundledPath, tool.source.archiveUrl, SOURCE_LIMIT, input.offline);
    const notices = await materializeNotices(input.bundle, tool.name, toolFiles);
    components.push({
      bomRef: `pkg:generic/${tool.name}@${encodeURIComponent(tool.version)}`,
      name: tool.displayName,
      version: tool.version,
      type: "application",
      purl: `pkg:generic/${tool.name}@${encodeURIComponent(tool.version)}`,
      license: { spdx: tool.license.spdx, ...license, sourceUrl: tool.license.sourceUrl },
      notices,
      bundledFiles: toolFiles,
      source: { kind: "archive", repositoryUrl: tool.source.repositoryUrl, commit: tool.commit, tag: tool.tag, archiveUrl: tool.source.archiveUrl, assetPath: source.path, sha256: source.sha256 },
      runtimeAsset: { name: text(runtimeAsset.assetName, `${tool.name}.assetName`), sha256: text(runtimeAsset.sha256, `${tool.name}.assetSha256`) },
      dependencies: tool.name === "musescore" ? tool.fonts.map((font) => `pkg:generic/${font.family.toLowerCase()}@${encodeURIComponent(`${tool.version}+bundled`)}`) : []
    });
    for (const font of tool.fonts) {
      const fontFiles = allFiles.filter((file) => file.path.startsWith(`${font.bundledPath}/`));
      if (fontFiles.length === 0) fail(`${font.family}: staged font files are missing`);
      const fontLicense = await materialize(input.bundle, font.license.bundledPath, font.license.sourceUrl, TEXT_LIMIT, input.offline);
      const assetPath = `THIRD_PARTY/sources/${font.family}-source-manifest.json`;
      const sourceManifest = { repositoryUrl: tool.source.repositoryUrl, commit: tool.commit, sourcePath: font.sourcePath };
      await mkdir(dirname(join(input.bundle, assetPath)), { recursive: true });
      await writeFile(join(input.bundle, assetPath), `${JSON.stringify(sourceManifest, null, 2)}\n`, "utf8");
      const version = `${tool.version}+bundled`;
      fontComponents.push({ bomRef: `pkg:generic/${font.family.toLowerCase()}@${encodeURIComponent(version)}`, name: font.family, version, type: "library", purl: `pkg:generic/${font.family.toLowerCase()}@${encodeURIComponent(version)}`, license: { spdx: font.license.spdx, ...fontLicense, sourceUrl: font.license.sourceUrl }, notices: [], bundledFiles: fontFiles, source: { kind: "manifest", repositoryUrl: tool.source.repositoryUrl, commit: tool.commit, tag: tool.tag, archiveUrl: tool.source.archiveUrl, assetPath, sha256: await sha256(join(input.bundle, assetPath)) }, dependencies: [] });
    }
  }
  return {
    schemaVersion: "yt2sheet-third-party-compliance/1",
    product: { name: text(packageRoot.name, "package name"), version: text(packageRoot.version, "package version"), purl: `pkg:npm/${encodeURIComponent(packageRoot.name)}@${encodeURIComponent(packageRoot.version)}` },
    coveredRoots: tools.map((tool) => `tools/${tool.name}`),
    components: [...components, ...fontComponents]
  };
}
