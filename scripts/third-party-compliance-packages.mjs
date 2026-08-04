import { fail } from "./third-party-compliance-manifest.mjs";

const SUPPORTED_LICENSES = new Set(["Apache-2.0", "GPL-3.0-or-later", "LGPL-2.1", "MIT"]);

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function text(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function packagePurl(name, version) {
  if (name.startsWith("@")) {
    const parts = name.split("/");
    if (parts.length !== 2 || parts.some((part) => part.length === 0)) fail(`invalid scoped direct dependency name: ${name}`);
    return `pkg:npm/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}@${encodeURIComponent(version)}`;
  }
  if (name.includes("/")) fail(`invalid direct dependency name: ${name}`);
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function sha512Integrity(value, label) {
  const source = text(value, label);
  if (!source.startsWith("sha512-") || source.includes(" ")) fail(`${label} must be one SHA-512 SRI digest`);
  const bytes = Buffer.from(source.slice("sha512-".length), "base64");
  if (bytes.length !== 64 || bytes.toString("base64") !== source.slice("sha512-".length)) fail(`${label} must be canonical SHA-512 SRI`);
  return bytes.toString("hex");
}

export function parseDirectPackages(input) {
  const lock = record(input, "package-lock");
  const packages = record(lock.packages, "package-lock.packages");
  const root = record(packages[""], "package-lock.packages root");
  const dependencies = record(root.dependencies, "package-lock direct dependencies");
  const names = Object.keys(dependencies).sort();
  if (names.length === 0) fail("package-lock direct dependencies must not be empty");
  const directRefs = new Map();
  const components = names.map((name) => {
    text(dependencies[name], `package-lock requested ${name}`);
    const entry = record(packages[`node_modules/${name}`], `package-lock entry ${name}`);
    const version = text(entry.version, `package-lock ${name}.version`);
    const license = text(entry.license, `package-lock ${name}.license`);
    if (!SUPPORTED_LICENSES.has(license)) fail(`${name}: unsupported direct dependency license ${license}`);
    const resolved = text(entry.resolved, `package-lock ${name}.resolved`);
    let url;
    try {
      url = new URL(resolved);
    } catch {
      fail(`package-lock ${name}.resolved must be an absolute HTTPS URL`);
    }
    if (url.protocol !== "https:") fail(`package-lock ${name}.resolved must be an absolute HTTPS URL`);
    const purl = packagePurl(name, version);
    directRefs.set(name, purl);
    return {
      bomRef: purl,
      name,
      version,
      type: "library",
      purl,
      license,
      sha512: sha512Integrity(entry.integrity, `package-lock ${name}.integrity`),
      resolved,
      requested: dependencies[name],
      dependencyNames: Object.keys(entry.dependencies ?? {}).sort()
    };
  });
  return Object.freeze(components.map((component) => Object.freeze({
    ...component,
    dependencies: Object.freeze(component.dependencyNames.flatMap((name) => directRefs.has(name) ? [directRefs.get(name)] : []))
  })));
}
