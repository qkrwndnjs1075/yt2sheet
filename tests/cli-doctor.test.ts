import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import type { MediaTools } from "../pipeline/media-tools";
import { defaultMediaTools } from "../pipeline/media-tools";
import { inspectDoctorScoreRuntimes } from "../cli/doctor-score-runtimes";
import { runLocalMediaSmoke } from "../cli/doctor-local-smoke";
import { loadScoreRuntimeManifest, type ScoreRuntimePlatform } from "../pipeline/score-runtime-manifest";
import {
  formatDoctorReport,
  runDoctor,
  type DoctorCheck,
  type DoctorDependencies,
  type DoctorResult,
  type DoctorTooling
} from "../cli/doctor";

test("formats a stable human-readable doctor report", () => {
  const result: DoctorResult = {
    status: "warning",
    exitCode: 0,
    checks: [
      { key: "system", label: "실행 환경", status: "pass", message: "macos arm64, Node v22" },
      { key: "cookies", label: "쿠키 설정", status: "warn", message: "선택 사항이며 설정되지 않았습니다." },
      { key: "network", label: "릴리스 네트워크", status: "skip", message: "--offline으로 건너뛰었습니다." }
    ]
  };

  assert.equal(formatDoctorReport(result), [
    "yt2 doctor",
    "",
    "✓ 실행 환경: macos arm64, Node v22",
    "! 쿠키 설정: 선택 사항이며 설정되지 않았습니다.",
    "- 릴리스 네트워크: --offline으로 건너뛰었습니다.",
    "",
    "결과: READY WITH WARNINGS"
  ].join("\n") + "\n");
});

test("offline doctor fails closed when npm skipped score runtimes are absent", async () => {
  const tools: MediaTools = {
    ytDlp: process.execPath,
    ffmpeg: process.execPath,
    ffprobe: process.execPath,
    ytDlpJsRuntime: process.execPath
  };
  const pass = (key: string, label: string, message: string): DoctorCheck => ({
    key,
    label,
    status: "pass",
    message
  });
  const tooling: DoctorTooling = {
    tools,
    checks: [pass("tools", "미디어 도구", "테스트 도구 준비됨")],
    canRunLocalSmoke: true,
    canCheckSource: true
  };
  let networkCalls = 0;
  let smokeCalls = 0;
  const dependencies: DoctorDependencies = {
    inspectTools: async () => tooling,
    runLocalSmoke: async () => {
      smokeCalls += 1;
      return pass("smoke", "로컬 스모크", "통과");
    },
    probeRelease: async () => {
      networkCalls += 1;
      return pass("network", "릴리스 네트워크", "통과");
    }
  };

  const previousSkip = process.env.YT2SHEET_SKIP_TOOL_INSTALL;
  process.env.YT2SHEET_SKIP_TOOL_INSTALL = "1";
  let result: DoctorResult;
  try {
    result = await runDoctor({ cwd: process.cwd(), offline: true }, dependencies);
  } finally {
    if (previousSkip === undefined) delete process.env.YT2SHEET_SKIP_TOOL_INSTALL;
    else process.env.YT2SHEET_SKIP_TOOL_INSTALL = previousSkip;
  }

  assert.equal(networkCalls, 0);
  assert.equal(smokeCalls, 1);
  assert.equal(result.exitCode, 1);
  assert.equal(result.checks.find((check) => check.key === "audiveris")?.status, "fail");
  assert.equal(result.checks.find((check) => check.key === "musescore")?.status, "fail");
  assert.equal(result.checks.find((check) => check.key === "network")?.status, "skip");
});

test("doctor accepts only a complete pinned runtime fixture with exact versions and hashes", async (t) => {
  const fixture = await createDoctorRuntimeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const healthy = await inspectDoctorScoreRuntimes(fixture.root, { platform: "darwin", architecture: "arm64" });
  assert.equal(healthy.available, true);
  assert.equal(healthy.checks.find((check) => check.key === "audiveris")?.status, "pass");
  assert.equal(healthy.checks.find((check) => check.key === "musescore")?.status, "pass");
  assert.equal(healthy.checks.find((check) => check.key === "musicxml-schema")?.status, "pass");
  assert.equal(healthy.checks.find((check) => check.key === "score-fonts")?.status, "pass");
  assert.equal(healthy.checks.find((check) => check.key === "compliance-sbom")?.status, "pass");

  await writeFile(fixture.audiverisExecutable, "#!/bin/sh\nprintf '5.10.9\\n'\n", "utf8");
  await chmod(fixture.audiverisExecutable, 0o755);
  await writeRuntimeInventory(fixture.root, fixture.platform);
  const mismatchedVersion = await inspectDoctorScoreRuntimes(fixture.root, { platform: "darwin", architecture: "arm64" });
  assert.equal(mismatchedVersion.available, false);
  assert.match(mismatchedVersion.checks.find((check) => check.key === "audiveris")?.message ?? "", /정확한 버전/);

  await writeFile(fixture.musescoreExecutable, "#!/bin/sh\nprintf '4.7.4\\n'\nprintf 'unexpected stderr\\n' >&2\n", "utf8");
  await chmod(fixture.musescoreExecutable, 0o755);
  await writeRuntimeInventory(fixture.root, fixture.platform);
  const conflictingProbe = await inspectDoctorScoreRuntimes(fixture.root, { platform: "darwin", architecture: "arm64" });
  assert.equal(conflictingProbe.available, false);
  assert.match(conflictingProbe.checks.find((check) => check.key === "musescore")?.detail ?? "", /stderr=/);
});

test("doctor accepts official runtime banners and the npm bootstrap asset shape", async (t) => {
  // Given: the verified macOS tools emit their official banners and npm carries runtime fonts inside MuseScore.
  const fixture = await createDoctorRuntimeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const manifest = await loadScoreRuntimeManifest(join(fixture.root, "scripts", "score-runtime-manifest.json"));
  await writeFile(fixture.audiverisExecutable, "#!/bin/sh\nprintf 'Audiveris\\n- Version:      5.11.0\\n'\n", "utf8");
  await chmod(fixture.audiverisExecutable, 0o755);
  const runtimeFonts = join(fixture.root, "tools/musescore/MuseScore 4.app/Contents/Resources/fonts");
  await mkdir(runtimeFonts, { recursive: true });
  for (const font of manifest.tools.musescore.fonts) {
    await rm(join(fixture.root, font.bundledPath), { recursive: true, force: true });
    await rm(join(fixture.root, font.license.bundledPath), { force: true });
    const fileName = font.family === "Bravura" ? "BravuraText.otf" : "Leland.otf";
    await writeFile(join(runtimeFonts, fileName), `${font.family} runtime font fixture\n`, "utf8");
  }
  await rm(join(fixture.root, "COMPLIANCE_SUMMARY.json"), { force: true });
  const sourceManifestPath = join(fixture.root, "SOURCE_MANIFEST.json");
  const sourceManifest = JSON.parse(await readFile(sourceManifestPath, "utf8")) as Record<string, unknown>;
  sourceManifest.packageKind = "npm-bootstrap";
  await writeFile(sourceManifestPath, `${JSON.stringify(sourceManifest)}\n`, "utf8");
  await writeRuntimeInventory(fixture.root, fixture.platform);

  // When: offline doctor inspects the npm-installed runtime tree.
  const result = await inspectDoctorScoreRuntimes(fixture.root, { platform: "darwin", architecture: "arm64" });

  // Then: the package-owned runtime and compliance checks remain available.
  assert.equal(result.available, true);
  assert.equal(result.checks.find((check) => check.key === "audiveris")?.status, "pass");
  assert.equal(result.checks.find((check) => check.key === "score-fonts")?.status, "pass");
  assert.equal(result.checks.find((check) => check.key === "compliance-sbom")?.status, "pass");
});

test("doctor fails closed for missing schema, mismatched font, and invalid SBOM artifacts", async (t) => {
  const fixture = await createDoctorRuntimeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const manifest = await loadScoreRuntimeManifest(join(fixture.root, "scripts", "score-runtime-manifest.json"));
  const schemaPath = join(fixture.root, manifest.standards.musicXml.schemas[0]?.bundledPath ?? "missing.xsd");
  await rm(schemaPath);
  const missingSchema = await inspectDoctorScoreRuntimes(fixture.root, { platform: "darwin", architecture: "arm64" });
  assert.equal(missingSchema.checks.find((check) => check.key === "musicxml-schema")?.status, "fail");
  await cp(join("vendor", "musicxml-4.0", "container.xsd"), schemaPath);

  const font = manifest.tools.musescore.fonts.find((candidate) => candidate.family === "Leland");
  if (font === undefined) throw new Error("doctor fixture Leland font missing");
  const fontPath = join(fixture.root, font.bundledPath, "Leland.otf");
  await writeFile(fontPath, "tampered font\n", "utf8");
  const mismatchedFont = await inspectDoctorScoreRuntimes(fixture.root, { platform: "darwin", architecture: "arm64" });
  assert.equal(mismatchedFont.checks.find((check) => check.key === "score-fonts")?.status, "fail");
  await writeFile(fontPath, "Leland pinned font fixture\n", "utf8");
  await writeRuntimeInventory(fixture.root, fixture.platform);

  const bomPath = join(fixture.root, "bom.cdx.json");
  const bom = JSON.parse(await readFile(bomPath, "utf8")) as Record<string, unknown>;
  bom.specVersion = "1.6";
  await writeFile(bomPath, `${JSON.stringify(bom)}\n`, "utf8");
  const invalidSbom = await inspectDoctorScoreRuntimes(fixture.root, { platform: "darwin", architecture: "arm64" });
  assert.equal(invalidSbom.checks.find((check) => check.key === "compliance-sbom")?.status, "fail");
});

test("doctor rejects a malformed manifest and absent staged executable", async (t) => {
  const fixture = await createDoctorRuntimeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  await writeFile(join(fixture.root, "scripts", "score-runtime-manifest.json"), "{\n", "utf8");
  const malformed = await inspectDoctorScoreRuntimes(fixture.root, { platform: "darwin", architecture: "arm64" });
  assert.equal(malformed.available, false);
  assert.equal(malformed.checks.find((check) => check.key === "runtime-manifest")?.status, "fail");

  await cp(resolve("scripts/score-runtime-manifest.json"), join(fixture.root, "scripts", "score-runtime-manifest.json"));
  await rm(fixture.musescoreExecutable);
  const missing = await inspectDoctorScoreRuntimes(fixture.root, { platform: "darwin", architecture: "arm64" });
  assert.equal(missing.available, false);
  assert.equal(missing.checks.find((check) => check.key === "musescore")?.status, "fail");
});

test("offline local smoke covers one-page PNG to MXL to PDF without network access", async () => {
  const result = await runLocalMediaSmoke(defaultMediaTools);

  assert.equal(result.status, "pass");
  assert.match(result.message, /PNG.*MXL.*PDF/u);
});

async function createDoctorRuntimeFixture(): Promise<{ readonly root: string; readonly platform: ScoreRuntimePlatform; readonly audiverisExecutable: string; readonly musescoreExecutable: string }> {
  const root = await mkdtemp(join(tmpdir(), "yt2sheet-doctor-runtime-"));
  await mkdir(join(root, "scripts"), { recursive: true });
  await cp(resolve("scripts/score-runtime-manifest.json"), join(root, "scripts", "score-runtime-manifest.json"));
  const manifest = await loadScoreRuntimeManifest(join(root, "scripts", "score-runtime-manifest.json"));
  const platform = manifest.platforms.find((candidate) => candidate.id === "macos-14-arm64");
  if (platform === undefined) throw new Error("doctor fixture platform missing");
  const audiverisExecutable = join(root, platform.runtimes.audiveris.stagedExecutable);
  const musescoreExecutable = join(root, platform.runtimes.musescore.stagedExecutable);
  await writeExecutable(audiverisExecutable, platform.runtimes.audiveris.versionProbe.expected);
  await writeExecutable(musescoreExecutable, platform.runtimes.musescore.versionProbe.expected);
  await writeDoctorStandardsFixture(root, manifest);
  await writeRuntimeInventory(root, platform);
  return { root, platform, audiverisExecutable, musescoreExecutable };
}

async function writeDoctorStandardsFixture(root: string, manifest: Awaited<ReturnType<typeof loadScoreRuntimeManifest>>): Promise<void> {
  await cp(resolve("vendor", "musicxml-4.0"), join(root, "vendor", "musicxml-4.0"), { recursive: true });
  const fontComponents: Array<Record<string, unknown>> = [];
  for (const font of manifest.tools.musescore.fonts) {
    const fontPath = join(root, font.bundledPath, `${font.family}.otf`);
    await mkdir(dirname(fontPath), { recursive: true });
    await writeFile(fontPath, `${font.family} pinned font fixture\n`, "utf8");
    const licensePath = join(root, font.license.bundledPath);
    await mkdir(dirname(licensePath), { recursive: true });
    await writeFile(licensePath, `${font.family} license fixture\n`, "utf8");
    fontComponents.push({ name: font.family, hashes: [{ alg: "SHA-256", content: await hashFile(fontPath) }] });
  }
  const bom = {
    bomFormat: "CycloneDX",
    specVersion: "1.7",
    version: 1,
    components: [{ name: "Audiveris" }, { name: "MuseScore" }, ...fontComponents]
  };
  const sourceManifest = { schemaVersion: "yt2sheet-source-manifest/1", sources: [], directPackages: [] };
  const notices = "# Third-Party Notices\n\nDoctor fixture\n";
  await writeFile(join(root, "bom.cdx.json"), `${JSON.stringify(bom)}\n`, "utf8");
  await writeFile(join(root, "SOURCE_MANIFEST.json"), `${JSON.stringify(sourceManifest)}\n`, "utf8");
  await writeFile(join(root, "THIRD_PARTY_NOTICES.md"), notices, "utf8");
  const artifacts = {
    "THIRD_PARTY_NOTICES.md": await hashFile(join(root, "THIRD_PARTY_NOTICES.md")),
    "bom.cdx.json": await hashFile(join(root, "bom.cdx.json")),
    "SOURCE_MANIFEST.json": await hashFile(join(root, "SOURCE_MANIFEST.json"))
  };
  await writeFile(join(root, "COMPLIANCE_SUMMARY.json"), `${JSON.stringify({ schemaVersion: "yt2sheet-compliance-summary/1", artifacts })}\n`, "utf8");
}

async function writeExecutable(path: string, version: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!/bin/sh\nprintf '${version}\\n'\n`, "utf8");
  await chmod(path, 0o755);
}

async function writeRuntimeInventory(root: string, platform: ScoreRuntimePlatform): Promise<void> {
  const entries: Array<Record<string, string | number>> = [];
  const visit = async (path: string): Promise<void> => {
    const details = await lstat(path);
    const entry = { path: relative(root, path).split(sep).join("/"), mode: (details.mode & 0o7777).toString(8).padStart(4, "0") };
    if (details.isDirectory()) {
      entries.push({ ...entry, type: "directory" });
      for (const child of (await readdir(path, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) await visit(join(path, child.name));
    } else if (details.isFile()) {
      entries.push({ ...entry, type: "file", size: details.size, sha256: await hashFile(path) });
    } else if (details.isSymbolicLink()) {
      const target = await readlink(path);
      entries.push({ ...entry, type: "symlink", target, sha256: hashText(target) });
    } else {
      throw new Error(`doctor fixture unsupported file type: ${path}`);
    }
  };
  await visit(join(root, "tools", "audiveris"));
  await visit(join(root, "tools", "musescore"));
  const archives = Object.fromEntries((Object.keys(platform.runtimes) as Array<"audiveris" | "musescore">).map((tool) => {
    const runtime = platform.runtimes[tool];
    return [tool, { assetName: runtime.assetName, sha256: runtime.sha256, extraction: runtime.extraction, stagedExecutable: runtime.stagedExecutable }];
  }));
  await writeFile(join(root, "tools", "score-runtime-inventory.json"), `${JSON.stringify({ schemaVersion: "score-runtime-inventory/1", platformId: platform.id, archives, versionProbes: { audiveris: "5.11.0", musescore: "4.7.4" }, entries }, null, 2)}\n`, "utf8");
}

async function hashFile(path: string): Promise<string> {
  return hashText(await readFile(path, "utf8"));
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
