import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { arch as currentArchitecture, platform as currentPlatform } from "node:process";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { loadScoreRuntimeManifest, resolveScoreRuntimeTarget, type ScoreRuntimeManifest, type ScoreRuntimePlatform } from "../pipeline/score-runtime-manifest";
import type { DoctorCheck } from "./doctor-contract";

const RUNTIME_TOOLS = ["audiveris", "musescore"] as const;
const STANDARD_CHECKS = ["musicxml-schema", "score-fonts", "compliance-sbom"] as const;
const VERSION_PROBE_TIMEOUT_MS = 15_000;
const MAX_PROBE_OUTPUT_BYTES = 64 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;

const inventoryEntrySchema = z.object({
  path: z.string().min(1),
  mode: z.string().regex(/^[0-7]{4}$/u),
  type: z.enum(["file", "directory", "symlink"]),
  size: z.number().int().nonnegative().optional(),
  sha256: z.string().regex(SHA256).optional(),
  target: z.string().optional()
}).strict();

const inventorySchema = z.object({
  schemaVersion: z.literal("score-runtime-inventory/1"),
  platformId: z.string().min(1),
  archives: z.record(z.string(), z.object({
    assetName: z.string().min(1),
    sha256: z.string().regex(SHA256),
    extraction: z.string().min(1),
    stagedExecutable: z.string().min(1)
  }).strict()),
  versionProbes: z.record(z.string(), z.string()),
  entries: z.array(inventoryEntrySchema).min(1)
}).strict();

type RuntimeInventory = z.infer<typeof inventorySchema>;
type RuntimeTool = (typeof RUNTIME_TOOLS)[number];
type StandardCheckKey = (typeof STANDARD_CHECKS)[number];
type ProbeOutput = {
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
};

export type DoctorScoreRuntimeResult = {
  readonly checks: readonly DoctorCheck[];
  readonly available: boolean;
};

export type DoctorScoreRuntimeOptions = {
  readonly platform?: string;
  readonly architecture?: string;
  readonly osReleasePath?: string;
};

export async function inspectDoctorScoreRuntimes(packageRoot: string, options: DoctorScoreRuntimeOptions = {}): Promise<DoctorScoreRuntimeResult> {
  const root = resolve(packageRoot);
  let manifest: ScoreRuntimeManifest;
  let platform: ScoreRuntimePlatform;
  try {
    manifest = await loadScoreRuntimeManifest(join(root, "scripts", "score-runtime-manifest.json"));
    platform = await resolveHostPlatform(manifest, options);
  } catch (error: unknown) {
    const detail = describeError(error);
    return {
      checks: [
        { key: "runtime-manifest", label: "점수 런타임 매니페스트", status: "fail", message: "고정된 점수 런타임 매니페스트를 확인할 수 없습니다.", detail },
        ...STANDARD_CHECKS.map((key) => standardFailure(key, "매니페스트 확인이 끝나지 않아 표준 자산을 검증하지 않았습니다.", detail)),
        ...RUNTIME_TOOLS.map((tool) => runtimeFailure(tool, "매니페스트/플랫폼 확인이 끝나지 않아 실행 파일을 검증하지 않았습니다."))
      ],
      available: false
    };
  }

  const standardChecks = await inspectStandardAssets(root, manifest);

  let inventory: RuntimeInventory;
  try {
    inventory = await loadInventory(root);
    await verifyInventory(root, platform, inventory);
  } catch (error: unknown) {
    const detail = describeError(error);
    return {
      checks: [
        { key: "runtime-manifest", label: "점수 런타임 매니페스트", status: "pass", message: `고정 매니페스트 확인됨 (${platform.id})` },
        ...standardChecks,
        ...RUNTIME_TOOLS.map((tool) => runtimeFailure(tool, "패키지 소유 런타임 인벤토리/해시 검증에 실패했습니다.", detail))
      ],
      available: false
    };
  }

  const toolChecks = await Promise.all(RUNTIME_TOOLS.map((tool) => inspectRuntimeTool(root, platform, inventory, tool)));
  return {
    checks: [
      { key: "runtime-manifest", label: "점수 런타임 매니페스트", status: "pass", message: `고정 매니페스트 확인됨 (${platform.id})` },
      ...standardChecks,
      ...toolChecks
    ],
    available: standardChecks.every((check) => check.status === "pass") && toolChecks.every((check) => check.status === "pass")
  };
}

async function inspectStandardAssets(root: string, manifest: ScoreRuntimeManifest): Promise<readonly DoctorCheck[]> {
  const checks = await Promise.all([
    inspectMusicXmlSchemas(root, manifest),
    inspectScoreFonts(root, manifest),
    inspectComplianceArtifacts(root, manifest)
  ]);
  return checks;
}

async function inspectMusicXmlSchemas(root: string, manifest: ScoreRuntimeManifest): Promise<DoctorCheck> {
  try {
    const originPath = resolvePackagePath(root, "vendor/musicxml-4.0/ORIGIN.json");
    const origin = parseOrigin(await readJson(originPath), originPath);
    if (origin.commit !== manifest.standards.musicXml.commit || origin.upstreamVersionDeclaration !== "4.0") {
      throw new Error("MusicXML 스키마 provenance가 고정된 4.0 매니페스트와 다릅니다.");
    }
    const expectedFiles = new Set<string>();
    for (const schema of manifest.standards.musicXml.schemas) {
      const fileName = basename(schema.bundledPath);
      expectedFiles.add(fileName);
      const expectedDigest = origin.files[fileName];
      if (expectedDigest === undefined) throw new Error(`MusicXML 스키마 provenance에 ${fileName}이 없습니다.`);
      const actualDigest = await digestFile(resolvePackagePath(root, schema.bundledPath));
      if (actualDigest !== expectedDigest) throw new Error(`MusicXML 스키마 SHA-256이 다릅니다: ${fileName}`);
    }
    if (Object.keys(origin.files).length !== expectedFiles.size || Object.keys(origin.files).some((file) => !expectedFiles.has(file))) {
      throw new Error("MusicXML 스키마 provenance 파일 목록이 매니페스트와 다릅니다.");
    }
    return { key: "musicxml-schema", label: "MusicXML 스키마", status: "pass", message: "고정된 MusicXML 4.0 스키마와 provenance를 확인했습니다." };
  } catch (error: unknown) {
    return standardFailure("musicxml-schema", "고정된 MusicXML 4.0 스키마를 확인할 수 없습니다.", describeError(error));
  }
}

async function inspectScoreFonts(root: string, manifest: ScoreRuntimeManifest): Promise<DoctorCheck> {
  try {
    const bom = await readJson(resolvePackagePath(root, "bom.cdx.json"));
    const components = recordArray(bom, "components");
    const fonts = manifest.tools.musescore.fonts;
    for (const font of fonts) {
      const directory = resolvePackagePath(root, font.bundledPath);
      const files = await collectRegularFiles(directory);
      if (files.length === 0) throw new Error(`${font.family} 폰트 파일이 없습니다.`);
      const licensePath = resolvePackagePath(root, font.license.bundledPath);
      if ((await readFile(licensePath)).byteLength === 0) throw new Error(`${font.family} 폰트 라이선스가 비어 있습니다.`);
      const component = components.find((candidate) => candidate.name === font.family);
      if (component === undefined) throw new Error(`SBOM에 ${font.family} 폰트 component가 없습니다.`);
      const hash = firstSha256(component);
      if (hash === undefined || hash !== await digestFile(files[0])) {
        throw new Error(`${font.family} 폰트 identity/hash가 SBOM과 다릅니다.`);
      }
    }
    return { key: "score-fonts", label: "악보 폰트", status: "pass", message: "Bravura/Leland 폰트 identity, 라이선스, SBOM hash를 확인했습니다." };
  } catch (error: unknown) {
    return standardFailure("score-fonts", "패키지 소유 악보 폰트 identity를 확인할 수 없습니다.", describeError(error));
  }
}

async function inspectComplianceArtifacts(root: string, manifest: ScoreRuntimeManifest): Promise<DoctorCheck> {
  try {
    const artifactNames = ["THIRD_PARTY_NOTICES.md", "bom.cdx.json", "SOURCE_MANIFEST.json"] as const;
    const artifacts = Object.fromEntries(await Promise.all(artifactNames.map(async (name) => [name, await readFile(resolvePackagePath(root, name))] as const))) as Record<typeof artifactNames[number], Buffer>;
    if (artifacts["THIRD_PARTY_NOTICES.md"].toString("utf8").trim().length === 0) throw new Error("THIRD_PARTY_NOTICES.md가 비어 있습니다.");
    const bom = parseJsonObject(artifacts["bom.cdx.json"], "bom.cdx.json");
    if (bom.bomFormat !== "CycloneDX" || bom.specVersion !== "1.7" || bom.version !== 1) throw new Error("CycloneDX 1.7 SBOM 계약이 올바르지 않습니다.");
    const sourceManifest = parseJsonObject(artifacts["SOURCE_MANIFEST.json"], "SOURCE_MANIFEST.json");
    if (sourceManifest.schemaVersion !== "yt2sheet-source-manifest/1" || !Array.isArray(sourceManifest.sources) || !Array.isArray(sourceManifest.directPackages)) {
      throw new Error("SOURCE_MANIFEST 계약이 올바르지 않습니다.");
    }
    const summary = parseJsonObject(await readFile(resolvePackagePath(root, "COMPLIANCE_SUMMARY.json")), "COMPLIANCE_SUMMARY.json");
    if (summary.schemaVersion !== "yt2sheet-compliance-summary/1" || typeof summary.artifacts !== "object" || summary.artifacts === null) {
      throw new Error("COMPLIANCE_SUMMARY 계약이 올바르지 않습니다.");
    }
    const summaryArtifacts = summary.artifacts as Record<string, unknown>;
    for (const name of artifactNames) {
      const expected = summaryArtifacts[name];
      if (typeof expected !== "string" || !SHA256.test(expected) || expected !== digestBytes(artifacts[name])) {
        throw new Error(`compliance artifact SHA-256이 다릅니다: ${name}`);
      }
    }
    const expectedComponents = new Set(["Audiveris", "MuseScore", ...manifest.tools.musescore.fonts.map((font) => font.family)]);
    const actualComponents = new Set(recordArray(bom, "components").map((component) => component.name).filter((name): name is string => typeof name === "string"));
    for (const name of expectedComponents) if (!actualComponents.has(name)) throw new Error(`SBOM component가 없습니다: ${name}`);
    return { key: "compliance-sbom", label: "SBOM/고지", status: "pass", message: "CycloneDX SBOM, source manifest, 고지, compliance digest를 확인했습니다." };
  } catch (error: unknown) {
    return standardFailure("compliance-sbom", "SBOM/고지 산출물을 확인할 수 없습니다.", describeError(error));
  }
}

async function resolveHostPlatform(manifest: ScoreRuntimeManifest, options: DoctorScoreRuntimeOptions): Promise<ScoreRuntimePlatform> {
  const hostPlatform = options.platform ?? currentPlatform;
  const hostArchitecture = options.architecture ?? currentArchitecture;
  if (hostPlatform === "darwin" && hostArchitecture === "arm64") {
    return resolveScoreRuntimeTarget(manifest, "darwin-arm64", "14");
  }
  if (hostPlatform === "darwin" && hostArchitecture === "x64") {
    return resolveScoreRuntimeTarget(manifest, "darwin-x64", "14");
  }
  if (hostPlatform === "win32" && hostArchitecture === "x64") {
    return resolveScoreRuntimeTarget(manifest, "windows-x64", "2022");
  }
  if (hostPlatform !== "linux" || hostArchitecture !== "x64") {
    throw new Error(`지원하지 않는 점수 런타임 호스트입니다: ${hostPlatform}-${hostArchitecture}`);
  }
  const source = await readFile(options.osReleasePath ?? process.env.YT2SHEET_OS_RELEASE_FILE?.trim() ?? "/etc/os-release", "utf8");
  const fields = Object.fromEntries(source.split(/\r?\n/u).flatMap((line) => {
    const match = /^([A-Z_]+)=(?:"([^"]*)"|'([^']*)'|([^#\s]*))$/u.exec(line);
    return match?.[1] ? [[match[1], match[2] ?? match[3] ?? match[4] ?? ""]] : [];
  }));
  if (fields.ID !== "ubuntu" || (fields.VERSION_ID !== "22.04" && fields.VERSION_ID !== "24.04")) {
    throw new Error(`지원하는 점수 런타임은 Ubuntu 22.04/24.04 x64입니다: ${fields.ID ?? "unknown"} ${fields.VERSION_ID ?? "unknown"}`);
  }
  return resolveScoreRuntimeTarget(manifest, "linux-x64", fields.VERSION_ID);
}

async function loadInventory(root: string): Promise<RuntimeInventory> {
  const source = await readFile(join(root, "tools", "score-runtime-inventory.json"), "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error: unknown) {
    throw new Error(`점수 런타임 인벤토리 JSON이 올바르지 않습니다: ${describeError(error)}`);
  }
  const result = inventorySchema.safeParse(parsed);
  if (!result.success) throw new Error(`점수 런타임 인벤토리 계약이 올바르지 않습니다: ${result.error.issues[0]?.message ?? "unknown"}`);
  return result.data;
}

async function verifyInventory(root: string, platform: ScoreRuntimePlatform, inventory: RuntimeInventory): Promise<void> {
  if (inventory.platformId !== platform.id) throw new Error(`런타임 인벤토리 플랫폼이 다릅니다: ${platform.id}`);
  const expectedEntries = new Map<string, RuntimeInventory["entries"][number]>();
  for (const entry of inventory.entries) {
    if (!safeInventoryPath(root, entry.path) || expectedEntries.has(entry.path)) throw new Error("런타임 인벤토리에 안전하지 않거나 중복된 경로가 있습니다.");
    expectedEntries.set(entry.path, entry);
  }
  const actualEntries = await collectInventoryPaths(root);
  if (actualEntries.length !== expectedEntries.size || actualEntries.some((path) => !expectedEntries.has(path))) {
    throw new Error("패키지 런타임 트리가 인벤토리와 일치하지 않습니다.");
  }
  for (const entry of inventory.entries) await verifyInventoryEntry(root, entry);
  for (const tool of RUNTIME_TOOLS) {
    const runtime = platform.runtimes[tool];
    const archive = inventory.archives[tool];
    if (archive === undefined || archive.assetName !== runtime.assetName || archive.sha256 !== runtime.sha256
      || archive.extraction !== runtime.extraction || archive.stagedExecutable !== runtime.stagedExecutable
      || inventory.versionProbes[tool] !== runtime.versionProbe.expected) {
      throw new Error(`${tool} 런타임 인벤토리가 고정 매니페스트와 일치하지 않습니다.`);
    }
  }
}

async function collectInventoryPaths(root: string): Promise<readonly string[]> {
  const paths: string[] = [];
  const visit = async (path: string): Promise<void> => {
    paths.push(relative(root, path).split(sep).join("/"));
    const details = await lstat(path);
    if (!details.isDirectory() || details.isSymbolicLink()) return;
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      await visit(join(path, entry.name));
    }
  };
  for (const tool of RUNTIME_TOOLS) await visit(join(root, "tools", tool));
  return paths.sort();
}

async function verifyInventoryEntry(root: string, entry: RuntimeInventory["entries"][number]): Promise<void> {
  const path = resolve(root, entry.path);
  const details = await lstat(path);
  if (details.isSymbolicLink() !== (entry.type === "symlink") || details.isFile() !== (entry.type === "file") || details.isDirectory() !== (entry.type === "directory")
    || (details.mode & 0o7777).toString(8).padStart(4, "0") !== entry.mode) throw new Error(`런타임 인벤토리 유형/권한이 다릅니다: ${entry.path}`);
  if (entry.type === "file") {
    if (entry.size !== details.size || entry.sha256 !== await digestFile(path)) throw new Error(`런타임 파일 해시가 다릅니다: ${entry.path}`);
  } else if (entry.type === "symlink") {
    if (entry.target !== await readlink(path) || entry.sha256 !== digestText(entry.target ?? "")) throw new Error(`런타임 심볼릭 링크가 다릅니다: ${entry.path}`);
    const destination = await realpath(path);
    const toolsRoot = resolve(root, "tools");
    if (!isWithin(toolsRoot, destination) || resolve(destination) === toolsRoot) throw new Error(`런타임 심볼릭 링크가 패키지 경계를 벗어납니다: ${entry.path}`);
  }
}

async function inspectRuntimeTool(root: string, platform: ScoreRuntimePlatform, inventory: RuntimeInventory, tool: RuntimeTool): Promise<DoctorCheck> {
  const runtime = platform.runtimes[tool];
  const executable = resolve(root, runtime.stagedExecutable);
  if (!runtime.stagedExecutable.startsWith(`tools/${tool}/`) || !isWithin(resolve(root, "tools"), executable)) {
    return runtimeFailure(tool, "매니페스트 실행 경로가 패키지 소유 tools 경계를 벗어납니다.");
  }
  try {
    const details = await lstat(executable);
    if (!details.isFile() || details.isSymbolicLink() || (platform.os !== "windows" && (details.mode & 0o111) === 0)) {
      return runtimeFailure(tool, "패키지 소유 staged executable이 일반 실행 파일이 아닙니다.");
    }
    const probe = await runVersionProbe(executable, runtime.versionProbe.args);
    const stdout = normalizeProbe(probe.stdout);
    const stderr = normalizeProbe(probe.stderr);
    if (probe.truncated || stdout !== runtime.versionProbe.expected || stderr !== "") {
      return runtimeFailure(tool, `정확한 버전 ${runtime.versionProbe.expected} 확인에 실패했습니다.`, `stdout=${digestText(stdout)}, stderr=${digestText(stderr)}${probe.truncated ? ", output-truncated" : ""}`);
    }
    if (inventory.versionProbes[tool] !== stdout) return runtimeFailure(tool, "인벤토리 버전과 실행 파일 버전이 다릅니다.");
    return { key: tool, label: tool === "audiveris" ? "Audiveris" : "MuseScore", status: "pass", message: `패키지 번들에서 정확한 버전 ${stdout} 확인됨` };
  } catch (error: unknown) {
    return runtimeFailure(tool, "패키지 소유 staged executable을 실행할 수 없습니다.", describeError(error));
  }
}

async function runVersionProbe(executable: string, args: readonly string[]): Promise<ProbeOutput> {
  return new Promise((resolveProbe, reject) => {
    const child = spawn(executable, [...args], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`버전 확인 프로세스가 ${VERSION_PROBE_TIMEOUT_MS}ms 안에 끝나지 않았습니다.`));
    }, VERSION_PROBE_TIMEOUT_MS);
    const append = (current: string, chunk: string): string => {
      const combined = current + chunk;
      if (combined.length <= MAX_PROBE_OUTPUT_BYTES) return combined;
      truncated = true;
      return combined.slice(-MAX_PROBE_OUTPUT_BYTES);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: string) => { stderr = append(stderr, chunk); });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => code === 0 ? finish(null, { stdout, stderr, truncated }) : finish(new Error(`버전 확인 프로세스가 실패했습니다 (exit ${String(code)}).`)));

    function finish(error: Error | null, output?: ProbeOutput): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else if (output !== undefined) resolveProbe(output);
      else reject(new Error("버전 확인 결과가 없습니다."));
    }
  });
}

function safeInventoryPath(root: string, path: string): boolean {
  return !isAbsolute(path) && !path.includes("\\") && !path.split("/").includes("..") && path.startsWith("tools/") && isWithin(resolve(root, "tools"), resolve(root, path));
}

function isWithin(root: string, path: string): boolean {
  const delta = relative(resolve(root), resolve(path));
  return delta !== ".." && !delta.startsWith(`..${sep}`) && !isAbsolute(delta);
}

async function digestFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

function digestText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digestBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function resolvePackagePath(root: string, path: string): string {
  if (isAbsolute(path) || path.includes("\\") || path.split("/").includes("..")) {
    throw new Error(`패키지 경로가 안전하지 않습니다: ${path}`);
  }
  const resolved = resolve(root, path);
  if (!isWithin(root, resolved)) throw new Error(`패키지 경로가 루트 밖입니다: ${path}`);
  return resolved;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error: unknown) {
    throw new Error(`${path} JSON을 읽을 수 없습니다: ${describeError(error)}`);
  }
}

function parseJsonObject(value: Uint8Array | unknown, label: string): Record<string, unknown> {
  let parsed: unknown = value;
  if (value instanceof Uint8Array) {
    try {
      parsed = JSON.parse(Buffer.from(value).toString("utf8"));
    } catch (error: unknown) {
      throw new Error(`${label} JSON이 올바르지 않습니다: ${describeError(error)}`);
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} JSON object가 필요합니다.`);
  return parsed as Record<string, unknown>;
}

function parseOrigin(value: unknown, label: string): { readonly commit: string; readonly upstreamVersionDeclaration: string; readonly files: Readonly<Record<string, string>> } {
  const origin = parseJsonObject(value, label);
  if (typeof origin.commit !== "string" || typeof origin.upstreamVersionDeclaration !== "string") {
    throw new Error(`${label} provenance 필드가 올바르지 않습니다.`);
  }
  const filesValue = origin.files;
  if (filesValue === null || typeof filesValue !== "object" || Array.isArray(filesValue)) throw new Error(`${label} provenance files가 올바르지 않습니다.`);
  const files: Record<string, string> = {};
  for (const [file, digest] of Object.entries(filesValue)) {
    if (typeof digest !== "string" || !SHA256.test(digest)) throw new Error(`${label} provenance digest가 올바르지 않습니다: ${file}`);
    files[file] = digest;
  }
  return { commit: origin.commit, upstreamVersionDeclaration: origin.upstreamVersionDeclaration, files };
}

function recordArray(value: unknown, key: string): readonly Record<string, unknown>[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${key} object가 필요합니다.`);
  const array = (value as Record<string, unknown>)[key];
  if (!Array.isArray(array) || array.some((entry) => entry === null || typeof entry !== "object" || Array.isArray(entry))) {
    throw new Error(`${key} array가 필요합니다.`);
  }
  return array as readonly Record<string, unknown>[];
}

function firstSha256(component: Record<string, unknown>): string | undefined {
  if (!Array.isArray(component.hashes)) return undefined;
  const hash = component.hashes.find((candidate) => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const value = candidate as Record<string, unknown>;
    return value.alg === "SHA-256" && typeof value.content === "string";
  });
  if (hash === null || hash === undefined || typeof hash !== "object" || Array.isArray(hash)) return undefined;
  const value = hash as Record<string, unknown>;
  return typeof value.content === "string" ? value.content : undefined;
}

async function collectRegularFiles(root: string): Promise<readonly string[]> {
  const details = await lstat(root);
  if (details.isSymbolicLink()) throw new Error(`폰트 디렉터리 심볼릭 링크는 허용되지 않습니다: ${root}`);
  if (!details.isDirectory()) throw new Error(`폰트 디렉터리가 아닙니다: ${root}`);
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const entryDetails = await lstat(path);
      if (entryDetails.isSymbolicLink()) throw new Error(`폰트 파일 심볼릭 링크는 허용되지 않습니다: ${path}`);
      if (entryDetails.isDirectory()) await visit(path);
      else if (entryDetails.isFile()) files.push(path);
      else throw new Error(`지원하지 않는 폰트 파일 형식입니다: ${path}`);
    }
  };
  await visit(root);
  return files.sort();
}

function normalizeProbe(value: string): string {
  return value.replace(/\r\n?/gu, "\n").trim();
}

function standardFailure(key: StandardCheckKey, message: string, detail?: string): DoctorCheck {
  const labels: Readonly<Record<StandardCheckKey, string>> = {
    "musicxml-schema": "MusicXML 스키마",
    "score-fonts": "악보 폰트",
    "compliance-sbom": "SBOM/고지"
  };
  return { key, label: labels[key], status: "fail", message, ...(detail ? { detail } : {}) };
}

function runtimeFailure(tool: RuntimeTool, message: string, detail?: string): DoctorCheck {
  return { key: tool, label: tool === "audiveris" ? "Audiveris" : "MuseScore", status: "fail", message, ...(detail ? { detail } : {}) };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
