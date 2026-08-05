import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, mkdtemp, opendir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { replaceDirectory } from "./atomic-directory-swap.mjs";
import { fail, parseManifestAndRequiredLicenses } from "./third-party-compliance-manifest.mjs";
import { parseDirectPackages } from "./third-party-compliance-packages.mjs";
import { deriveProductionManifest } from "./third-party-compliance-production.mjs";

function parseArgs(argv) {
  const values = new Map();
  const valueOptions = new Set(["--manifest", "--runtime-manifest", "--platform", "--package-lock", "--bundle", "--output"]);
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--offline") {
      values.set(option, "true");
      continue;
    }
    const value = argv[index + 1];
    if (!valueOptions.has(option) || value === undefined || value.startsWith("--")) {
      fail("usage: (--manifest <path> | --runtime-manifest <path> --platform <id>) --package-lock <path> --bundle <path> --output <path> [--offline]");
    }
    if (values.has(option)) fail(`duplicate option ${option}`);
    values.set(option, value);
    index += 1;
  }
  for (const option of ["--package-lock", "--bundle", "--output"]) {
    if (!values.has(option)) fail(`missing required option ${option}`);
  }
  const fixtureMode = values.has("--manifest");
  const productionMode = values.has("--runtime-manifest") || values.has("--platform");
  if (fixtureMode === productionMode || (productionMode && (!values.has("--runtime-manifest") || !values.has("--platform")))) fail("select exactly one complete manifest mode");
  return Object.freeze({
    manifest: fixtureMode ? resolve(values.get("--manifest")) : undefined,
    runtimeManifest: productionMode ? resolve(values.get("--runtime-manifest")) : undefined,
    platform: values.get("--platform"),
    packageLock: resolve(values.get("--package-lock")),
    bundle: resolve(values.get("--bundle")),
    output: resolve(values.get("--output")),
    offline: values.has("--offline")
  });
}

async function hashFile(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function verifyFile(bundle, file, label) {
  const path = join(bundle, file.path);
  let actual;
  try {
    actual = await hashFile(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") fail(`${label} file is missing: ${file.path}`);
    throw error;
  }
  if (actual !== file.sha256) fail(`${label} SHA-256 mismatch for ${file.path}`);
  return path;
}

async function filesBelow(root, relativeRoot) {
  const found = [];
  async function visit(relativeDirectory) {
    let directory;
    try {
      directory = await opendir(join(root, relativeDirectory));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") fail(`covered bundle root is missing: ${relativeDirectory}`);
      throw error;
    }
    for await (const entry of directory) {
      const path = posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) found.push(path);
      else if (entry.isSymbolicLink()) {
        const actual = await realpath(join(root, path));
        const escape = relative(root, actual);
        if (escape === ".." || escape.startsWith(`..${sep}`)) fail(`bundle symlink escapes root: ${path}`);
        found.push(path);
      }
      else fail(`unsupported bundle entry: ${path}`);
    }
  }
  await visit(relativeRoot);
  return found;
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function bomFor(manifest, directPackages) {
  const bundledComponents = manifest.components.map((component) => ({
    type: component.type,
    "bom-ref": component.bomRef,
    name: component.name,
    version: component.version,
    hashes: [{ alg: "SHA-256", content: component.bundledFiles[0].sha256 }],
    licenses: [component.license.spdx.includes(" WITH ") ? { expression: component.license.spdx } : { license: { id: component.license.spdx } }],
    purl: component.purl,
    externalReferences: [
      { type: "vcs", url: `${component.source.repositoryUrl}/tree/${component.source.commit}` },
      { type: "distribution", url: component.source.archiveUrl ?? component.source.repositoryUrl, hashes: [{ alg: "SHA-256", content: component.source.sha256 }] },
      { type: "license", url: component.license.sourceUrl, hashes: [{ alg: "SHA-256", content: component.license.sha256 }] }
    ],
    properties: [
      { name: "yt2sheet:source:commit", value: component.source.commit },
      { name: "yt2sheet:source:release-asset", value: component.source.assetPath },
      ...(component.source.tag === undefined ? [] : [{ name: "yt2sheet:source:tag", value: component.source.tag }]),
      ...(component.runtimeAsset === undefined ? [] : [{ name: "yt2sheet:runtime:asset", value: component.runtimeAsset.name }, { name: "yt2sheet:runtime:sha256", value: component.runtimeAsset.sha256 }])
    ]
  }));
  const packageComponents = directPackages.map((component) => ({
    type: component.type,
    "bom-ref": component.bomRef,
    name: component.name,
    version: component.version,
    hashes: [{ alg: "SHA-512", content: component.sha512 }],
    licenses: [{ license: { id: component.license } }],
    purl: component.purl,
    externalReferences: [{ type: "distribution", url: component.resolved, hashes: [{ alg: "SHA-512", content: component.sha512 }] }],
    properties: [{ name: "yt2sheet:npm:requested", value: component.requested }]
  }));
  const components = [...bundledComponents, ...packageComponents].sort((left, right) => left.purl.localeCompare(right.purl));
  return {
    "$schema": "http://cyclonedx.org/schema/bom-1.7.schema.json",
    bomFormat: "CycloneDX",
    specVersion: "1.7",
    version: 1,
    metadata: { component: { type: "application", "bom-ref": manifest.product.purl, name: manifest.product.name, version: manifest.product.version, purl: manifest.product.purl } },
    components,
    dependencies: [
      { ref: manifest.product.purl, dependsOn: components.map(({ "bom-ref": ref }) => ref) },
      ...manifest.components.map((component) => ({ ref: component.bomRef, dependsOn: [...component.dependencies].sort() })),
      ...directPackages.map((component) => ({ ref: component.bomRef, dependsOn: [...component.dependencies].sort() }))
    ]
  };
}

async function generate(paths, manifest, directPackages) {
  if (paths.output === paths.bundle || paths.output.startsWith(`${paths.bundle}${sep}`)) fail("output must be outside the input bundle");
  const coveredList = manifest.components.flatMap(({ bundledFiles }) => bundledFiles.map(({ path }) => path));
  const covered = new Set(coveredList);
  const actualCovered = (await Promise.all(manifest.coveredRoots.map((root) => filesBelow(paths.bundle, root)))).flat().sort();
  if (coveredList.length !== covered.size || actualCovered.length !== covered.size || actualCovered.some((path) => !covered.has(path))) fail("every file under coveredRoots must have exactly one component mapping");
  for (const component of manifest.components) {
    if (component.bundledFiles.length === 0) fail(`${component.name}: at least one bundled file is required`);
    for (const file of component.bundledFiles) await verifyFile(paths.bundle, file, `${component.name} bundled artifact`);
    await verifyFile(paths.bundle, component.license, `${component.name} license`);
    for (const notice of component.notices) await verifyFile(paths.bundle, notice, `${component.name} notice`);
    await verifyFile(paths.bundle, { path: component.source.assetPath, sha256: component.source.sha256 }, `${component.name} source asset`);
  }
  const complianceList = manifest.components.flatMap((component) => [component.license.path, ...component.notices.map(({ path }) => path), component.source.assetPath]);
  const compliancePaths = new Set(complianceList);
  const actualCompliance = (await Promise.all(["THIRD_PARTY/licenses", "THIRD_PARTY/fonts", "THIRD_PARTY/notices", "THIRD_PARTY/sources"].map((root) => filesBelow(paths.bundle, root)))).flat();
  if (complianceList.length !== compliancePaths.size || actualCompliance.length !== compliancePaths.size || actualCompliance.some((path) => !compliancePaths.has(path))) fail("every bundled THIRD_PARTY license, notice, font notice, and source asset must have exactly one manifest mapping");

  await mkdir(dirname(paths.output), { recursive: true });
  const temporary = await mkdtemp(join(dirname(paths.output), ".compliance-stage-"));
  try {
    for (const component of manifest.components) {
      for (const file of [component.license, ...component.notices, { path: component.source.assetPath }]) {
        const destination = join(temporary, file.path);
        await mkdir(dirname(destination), { recursive: true });
        await cp(join(paths.bundle, file.path), destination);
      }
    }
    const sourceManifest = {
      schemaVersion: "yt2sheet-source-manifest/1",
      sources: manifest.components.map((component) => ({ name: component.name, version: component.version, repositoryUrl: component.source.repositoryUrl, commit: component.source.commit, tag: component.source.tag, archiveUrl: component.source.archiveUrl, kind: component.source.kind, releaseAsset: component.source.assetPath, sha256: component.source.sha256, runtimeAsset: component.runtimeAsset })),
      directPackages: directPackages.map((component) => ({ name: component.name, version: component.version, resolved: component.resolved, sha512: component.sha512 }))
    };
    const noticeLines = [
      "# Third-Party Notices",
      "",
      "This is an automated engineering inventory, not legal advice or a legal conclusion.",
      ""
    ];
    for (const component of manifest.components) {
      noticeLines.push(`## ${component.name} ${component.version}`, "", `- Package URL: \`${component.purl}\``, `- SPDX: \`${component.license.spdx}\``, `- License: \`${component.license.path}\` (SHA-256 \`${component.license.sha256}\`)`, `- Source commit: \`${component.source.commit}\``, `- Source release asset: \`${component.source.assetPath}\` (SHA-256 \`${component.source.sha256}\`)`);
      for (const notice of component.notices) noticeLines.push(`- Notice: \`${notice.path}\` (SHA-256 \`${notice.sha256}\`)`);
      noticeLines.push("");
    }
    for (const component of directPackages) {
      noticeLines.push(`## ${component.name} ${component.version}`, "", `- Package URL: \`${component.purl}\``, `- SPDX: \`${component.license}\``, `- Registry source: \`${component.resolved}\` (SHA-512 \`${component.sha512}\`)`, `- Requested range: \`${component.requested}\``, "");
    }
    const artifacts = {
      "THIRD_PARTY_NOTICES.md": `${noticeLines.join("\n")}\n`,
      "bom.cdx.json": json(bomFor(manifest, directPackages)),
      "SOURCE_MANIFEST.json": json(sourceManifest)
    };
    for (const [path, content] of Object.entries(artifacts)) await writeFile(join(temporary, path), content, "utf8");
    const summary = {
      schemaVersion: "yt2sheet-compliance-summary/1",
      componentCount: manifest.components.length + directPackages.length,
      licenseCount: manifest.components.length + directPackages.length,
      noticeCount: manifest.components.reduce((count, component) => count + component.notices.length, 0),
      sourceCount: manifest.components.length,
      directPackageCount: directPackages.length,
      coveredFileCount: covered.size,
      artifacts: Object.fromEntries(await Promise.all(Object.keys(artifacts).sort().map(async (path) => [path, await hashFile(join(temporary, path))])))
    };
    await writeFile(join(temporary, "COMPLIANCE_SUMMARY.json"), json(summary), "utf8");
    await replaceDirectory(temporary, paths.output);
    return summary;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const paths = parseArgs(process.argv.slice(2));
  let packageLockInput;
  try {
    packageLockInput = JSON.parse(await readFile(paths.packageLock, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) fail(`package-lock contains malformed JSON: ${error.message}`);
    throw error;
  }
  let manifestInput;
  try {
    if (paths.manifest !== undefined) manifestInput = JSON.parse(await readFile(paths.manifest, "utf8"));
    else manifestInput = await deriveProductionManifest({ runtimeManifest: JSON.parse(await readFile(paths.runtimeManifest, "utf8")), packageLock: packageLockInput, platformId: paths.platform, bundle: paths.bundle, offline: paths.offline });
  } catch (error) {
    if (error instanceof SyntaxError) fail(`manifest contains malformed JSON: ${error.message}`);
    throw error;
  }
  const manifest = await parseManifestAndRequiredLicenses(manifestInput, paths.bundle);
  const summary = await generate(paths, manifest, parseDirectPackages(packageLockInput));
  process.stdout.write(json({ status: "generated", output: paths.output, summary }));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
