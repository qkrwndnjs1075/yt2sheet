import { access } from "node:fs/promises";
import { basename, isAbsolute, join, posix } from "node:path";

const SPDX_IDS = new Set(["AGPL-3.0-only", "GPL-3.0-only", "GPL-2.0-only WITH Classpath-exception-2.0", "MIT", "OFL-1.1"]);
const COMPONENT_TYPES = new Set(["application", "framework", "library"]);
const SOURCE_KINDS = new Set(["archive", "manifest", "submodule-manifest"]);
const REQUIRED_LICENSES = Object.freeze([
  ["Audiveris", "THIRD_PARTY/licenses/Audiveris-LICENSE"],
  ["MuseScore", "THIRD_PARTY/licenses/MuseScore-LICENSE.txt"],
  ["Bravura", "THIRD_PARTY/fonts/Bravura-OFL.txt"],
  ["Leland", "THIRD_PARTY/fonts/Leland-LICENSE.txt"]
]);

class ComplianceError extends Error {
  constructor(message) {
    super(`Compliance generation blocked: ${message}`);
    this.name = "ComplianceError";
  }
}

export function fail(message) {
  throw new ComplianceError(message);
}

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function text(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function list(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function httpsUrl(value, label) {
  const source = text(value, label);
  let parsed;
  try {
    parsed = new URL(source);
  } catch {
    fail(`${label} must be an absolute HTTPS URL`);
  }
  if (parsed.protocol !== "https:") fail(`${label} must be an absolute HTTPS URL`);
  return source;
}

function digest(value, label) {
  const source = text(value, label);
  if (!/^[a-f0-9]{64}$/.test(source)) fail(`${label} must be a lowercase SHA-256`);
  return source;
}

function relativePath(value, label) {
  const source = text(value, label);
  if (isAbsolute(source) || source.includes("\\") || posix.normalize(source) !== source || source.startsWith("../") || source.includes("/../")) {
    fail(`${label} must be a safe bundle-relative path`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._+ ()-]*$/.test(basename(source))) fail(`${label} must have a safe filename`);
  if (/\.pdf$/i.test(source) && /(?:^|[/_. -])(?:iso|iec)(?:[/_. -]|$)/i.test(source)) fail(`${label}: ISO normative PDF content is prohibited`);
  return source;
}

function purl(value, version, label) {
  const source = text(value, label);
  const match = /^pkg:[a-z0-9.+-]+\/[^@?#]+@([^?#]+)(?:[?#].*)?$/.exec(source);
  if (match === null) fail(`${label} must be a versioned package URL`);
  let encodedVersion;
  try {
    encodedVersion = decodeURIComponent(match[1]);
  } catch {
    fail(`${label} must be a valid encoded package URL`);
  }
  if (encodedVersion !== version) fail(`${label}: purl version must match component version`);
  return source;
}

function parseFile(value, label) {
  const input = record(value, label);
  return Object.freeze({ path: relativePath(input.path, `${label}.path`), sha256: digest(input.sha256, `${label}.sha256`) });
}

function parseComponent(value, index) {
  const label = `components[${index}]`;
  const input = record(value, label);
  const name = text(input.name, `${label}.name`);
  const version = text(input.version, `${label}.version`);
  const type = text(input.type, `${label}.type`);
  if (!COMPONENT_TYPES.has(type)) fail(`${label}.type is unsupported`);
  const componentPurl = purl(input.purl, version, `${label}.purl`);
  const bomRef = text(input.bomRef, `${label}.bomRef`);
  if (bomRef !== componentPurl) fail(`${label}.bomRef must equal its purl`);
  const licenseInput = record(input.license, `${label}.license`);
  const spdx = text(licenseInput.spdx, `${label}.license.spdx`);
  if (!SPDX_IDS.has(spdx)) fail(`${name}: unsupported SPDX identifier ${spdx}`);
  const sourceInput = input.source === undefined ? fail(`${name}: source mapping is required`) : record(input.source, `${label}.source`);
  const kind = text(sourceInput.kind, `${label}.source.kind`);
  if (!SOURCE_KINDS.has(kind)) fail(`${label}.source.kind is unsupported`);
  const commit = text(sourceInput.commit, `${label}.source.commit`);
  if (!/^[a-f0-9]{40}$/.test(commit)) fail(`${label}.source.commit must be a pinned 40-character commit`);
  return Object.freeze({
    bomRef,
    name,
    version,
    type,
    purl: componentPurl,
    license: Object.freeze({ spdx, path: relativePath(licenseInput.path, `${label}.license.path`), sha256: digest(licenseInput.sha256, `${label}.license.sha256`), sourceUrl: httpsUrl(licenseInput.sourceUrl, `${label}.license.sourceUrl`) }),
    notices: Object.freeze(list(input.notices, `${label}.notices`).map((notice, noticeIndex) => parseFile(notice, `${label}.notices[${noticeIndex}]`))),
    bundledFiles: Object.freeze(list(input.bundledFiles, `${label}.bundledFiles`).map((file, fileIndex) => parseFile(file, `${label}.bundledFiles[${fileIndex}]`))),
    source: Object.freeze({ kind, repositoryUrl: httpsUrl(sourceInput.repositoryUrl, `${label}.source.repositoryUrl`), commit, tag: sourceInput.tag === undefined ? undefined : text(sourceInput.tag, `${label}.source.tag`), archiveUrl: sourceInput.archiveUrl === undefined ? undefined : httpsUrl(sourceInput.archiveUrl, `${label}.source.archiveUrl`), assetPath: relativePath(sourceInput.assetPath, `${label}.source.assetPath`), sha256: digest(sourceInput.sha256, `${label}.source.sha256`) }),
    runtimeAsset: input.runtimeAsset === undefined ? undefined : Object.freeze({ name: text(record(input.runtimeAsset, `${label}.runtimeAsset`).name, `${label}.runtimeAsset.name`), sha256: digest(input.runtimeAsset.sha256, `${label}.runtimeAsset.sha256`) }),
    dependencies: Object.freeze(list(input.dependencies, `${label}.dependencies`).map((dependency, dependencyIndex) => text(dependency, `${label}.dependencies[${dependencyIndex}]`)))
  });
}

export function parseManifest(input) {
  const root = record(input, "manifest");
  if (root.schemaVersion !== "yt2sheet-third-party-compliance/1") fail("manifest.schemaVersion is unsupported");
  const productInput = record(root.product, "manifest.product");
  const productVersion = text(productInput.version, "manifest.product.version");
  const components = list(root.components, "manifest.components").map(parseComponent).sort((left, right) => left.purl.localeCompare(right.purl));
  if (components.length === 0 || new Set(components.map(({ bomRef }) => bomRef)).size !== components.length) fail("component bom-ref values must be present and unique");
  const refs = new Set(components.map(({ bomRef }) => bomRef));
  for (const component of components) {
    for (const dependency of component.dependencies) if (!refs.has(dependency)) fail(`${component.name}: dependency ${dependency} has no component mapping`);
  }
  for (const [name, spdx] of new Map([["Audiveris", "AGPL-3.0-only"], ["MuseScore", "GPL-3.0-only"], ["Bravura", "OFL-1.1"], ["Leland", "OFL-1.1"]])) {
    const component = components.find((candidate) => candidate.name === name);
    if (component === undefined || component.license.spdx !== spdx) fail(`${name}: exact ${spdx} license mapping is required`);
  }
  return Object.freeze({
    product: Object.freeze({ name: text(productInput.name, "manifest.product.name"), version: productVersion, purl: purl(productInput.purl, productVersion, "manifest.product.purl") }),
    coveredRoots: Object.freeze(list(root.coveredRoots, "manifest.coveredRoots").map((path, index) => relativePath(path, `manifest.coveredRoots[${index}]`))),
    components: Object.freeze(components)
  });
}

export async function parseManifestAndRequiredLicenses(input, bundle) {
  const issues = [];
  let manifest;
  try {
    manifest = parseManifest(input);
  } catch (error) {
    if (!(error instanceof ComplianceError)) throw error;
    issues.push(error.message.replace(/^Compliance generation blocked: /, ""));
  }
  for (const [name, path] of REQUIRED_LICENSES) {
    try {
      await access(join(bundle, path));
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      issues.push(`${name} license file is missing: ${path}`);
    }
  }
  if (issues.length > 0) fail(issues.join("; "));
  return manifest;
}
