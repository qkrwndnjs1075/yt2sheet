import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

const RELEASE_TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "windows-x64"] as const;
const PLATFORM_IDS = ["macos-14-arm64", "macos-14-x64", "ubuntu-22.04-x64", "ubuntu-24.04-x64", "windows-2022-x64"] as const;
const SHA256 = /^[a-f0-9]{64}$/;
const PINNED = {
  audiverisCommit: "9e1e55cd2746037d059345881c53e6a6754bffbd",
  musescoreCommit: "7688c005ad963ba09ee715aae53dbc7e8c9d5ef8",
  schemaCommit: "799e2defb2ece0ae7bafe08dcbcac25b2c631d53"
} as const;

const httpsUrlSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !/(?:^|[/_.-])latest(?:[/_.-]|$)/i.test(url.pathname);
}, "must be a pinned HTTPS URL without a latest segment");

const sourceSchema = z.object({
  repositoryUrl: httpsUrlSchema,
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  archiveUrl: httpsUrlSchema,
  bundledPath: z.string().min(1)
}).strict();

const licenseSchema = z.object({
  spdx: z.enum(["AGPL-3.0-only", "GPL-3.0-only", "OFL-1.1"]),
  sourceUrl: httpsUrlSchema,
  bundledPath: z.string().min(1)
}).strict();

const fontSchema = z.object({
  family: z.enum(["Bravura", "Leland"]),
  sourcePath: z.string().min(1),
  bundledPath: z.string().min(1),
  license: licenseSchema
}).strict();

const toolSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  tag: z.string().min(1),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  source: sourceSchema,
  license: licenseSchema,
  fonts: z.array(fontSchema)
}).strict();

const artifactSchema = z.object({
  assetName: z.string().min(1),
  url: httpsUrlSchema,
  sha256: z.string().regex(SHA256),
  extraction: z.enum(["msi-admin", "dmg-copy-app", "deb-extract", "appimage-extract"]),
  stagedExecutable: z.string().min(1).refine((value) => !value.startsWith("/") && !value.includes("..") && !value.includes("\\") && !/^[A-Za-z]:/.test(value), "must be a safe POSIX-style relative staged path"),
  versionProbe: z.object({
    args: z.array(z.string()).min(1),
    expected: z.string().min(1)
  }).strict()
}).strict();

const platformSchema = z.object({
  id: z.enum(PLATFORM_IDS),
  releaseTarget: z.enum(RELEASE_TARGETS),
  os: z.enum(["windows", "macos", "ubuntu"]),
  osVersion: z.enum(["2022", "14", "22.04", "24.04"]),
  arch: z.enum(["x64", "arm64"]),
  runtimes: z.object({ audiveris: artifactSchema, musescore: artifactSchema }).strict()
}).strict();

const manifestSchema = z.object({
  schemaVersion: z.literal("score-runtime-manifest/1"),
  releaseTargets: z.array(z.enum(RELEASE_TARGETS)).length(4),
  tools: z.object({ audiveris: toolSchema, musescore: toolSchema }).strict(),
  standards: z.object({
    musicXml: z.object({
      version: z.literal("4.0"),
      repositoryUrl: httpsUrlSchema,
      commit: z.literal(PINNED.schemaCommit),
      schemas: z.array(z.object({
        sourcePath: z.enum(["schema/container.xsd", "schema/musicxml.xsd", "schema/opus.xsd", "schema/sounds.xsd", "schema/xlink.xsd", "schema/xml.xsd"]),
        sourceUrl: httpsUrlSchema,
        bundledPath: z.string().min(1)
      }).strict()).length(6)
    }).strict()
  }).strict(),
  npmDependencies: z.object({
    "libxml2-wasm": z.literal("0.7.1"),
    fflate: z.literal("0.8.3")
  }).strict(),
  platforms: z.array(platformSchema).length(5)
}).strict().superRefine((manifest, context) => {
  if (new Set(manifest.releaseTargets).size !== RELEASE_TARGETS.length || [...manifest.releaseTargets].sort().join() !== RELEASE_TARGETS.join()) {
    context.addIssue({ code: "custom", path: ["releaseTargets"], message: "must contain each supported release target exactly once" });
  }
  if (manifest.tools.audiveris.tag !== "5.11.0" || manifest.tools.audiveris.commit !== PINNED.audiverisCommit) {
    context.addIssue({ code: "custom", path: ["tools", "audiveris"], message: "Audiveris tag/commit is not pinned" });
  }
  if (manifest.tools.musescore.tag !== "v4.7.4" || manifest.tools.musescore.commit !== PINNED.musescoreCommit) {
    context.addIssue({ code: "custom", path: ["tools", "musescore"], message: "MuseScore tag/commit is not pinned" });
  }
  if (manifest.tools.audiveris.version !== "5.11.0" || manifest.tools.musescore.version !== "4.7.4") {
    context.addIssue({ code: "custom", path: ["tools"], message: "tool versions are not pinned" });
  }
  validatePinnedMetadata(manifest, context);
  for (const tool of ["audiveris", "musescore"] as const) {
    const record = manifest.tools[tool];
    if (record.source.commit !== record.commit || !record.source.archiveUrl.includes(record.commit) || !record.license.sourceUrl.includes(record.commit)) {
      context.addIssue({ code: "custom", path: ["tools", tool], message: "source and license records must use the pinned tool commit" });
    }
  }
  const fontFamilies = manifest.tools.musescore.fonts.map(({ family }) => family).sort().join();
  if (manifest.tools.audiveris.fonts.length !== 0 || fontFamilies !== "Bravura,Leland") {
    context.addIssue({ code: "custom", path: ["tools", "musescore", "fonts"], message: "bundled font records must contain Bravura and Leland exactly once" });
  }
  const ids = manifest.platforms.map(({ id }) => id);
  if (new Set(ids).size !== PLATFORM_IDS.length || [...ids].sort().join() !== [...PLATFORM_IDS].sort().join()) {
    context.addIssue({ code: "custom", path: ["platforms"], message: "must contain each supported platform record exactly once" });
  }
  manifest.platforms.forEach((platform, index) => {
    const paths = Object.values(platform.runtimes).map(({ stagedExecutable }) => stagedExecutable.toLowerCase());
    if (new Set(paths).size !== paths.length) {
      context.addIssue({ code: "custom", path: ["platforms", index, "runtimes"], message: "staged executable paths must be unique per platform" });
    }
  });
  validatePinnedArtifacts(manifest.platforms, context);
  const schemaUrls = manifest.standards.musicXml.schemas.map(({ sourceUrl }) => sourceUrl);
  const schemaPaths = manifest.standards.musicXml.schemas.map(({ sourcePath }) => sourcePath);
  if (new Set(schemaPaths).size !== 6 || schemaUrls.some((url) => !url.includes(PINNED.schemaCommit))) {
    context.addIssue({ code: "custom", path: ["standards", "musicXml", "schemas"], message: "schema URLs must use the pinned commit" });
  }
});

export type ScoreRuntimeManifest = z.infer<typeof manifestSchema>;
export type ScoreRuntimePlatform = ScoreRuntimeManifest["platforms"][number];

export class ScoreRuntimeManifestError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid score runtime manifest: ${issues.join("; ")}`);
    this.name = "ScoreRuntimeManifestError";
    this.issues = issues;
  }
}

export function parseScoreRuntimeManifest(input: unknown): ScoreRuntimeManifest {
  const result = manifestSchema.safeParse(input);
  if (!result.success) {
    throw new ScoreRuntimeManifestError(result.error.issues.map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`));
  }
  return result.data;
}

export async function loadScoreRuntimeManifest(manifestPath: string | URL = resolve(process.cwd(), "scripts/score-runtime-manifest.json")): Promise<ScoreRuntimeManifest> {
  const source = await readFile(manifestPath, "utf8");
  try {
    return parseScoreRuntimeManifest(JSON.parse(source));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ScoreRuntimeManifestError([`manifest: malformed JSON (${error.message})`]);
    }
    throw error;
  }
}

export function resolveScoreRuntimeTarget(manifest: ScoreRuntimeManifest, releaseTarget: string, osVersion?: string): ScoreRuntimePlatform {
  const matches = manifest.platforms.filter((platform) => platform.releaseTarget === releaseTarget && (osVersion === undefined || platform.osVersion === osVersion));
  if (matches.length !== 1) {
    throw new ScoreRuntimeManifestError([`target: expected one platform for ${releaseTarget}${osVersion ? `/${osVersion}` : ""}, found ${matches.length}`]);
  }
  const match = matches[0];
  if (match === undefined) {
    throw new ScoreRuntimeManifestError(["target: resolved platform is absent"]);
  }
  return match;
}

function validatePinnedArtifacts(platforms: readonly z.infer<typeof platformSchema>[], context: z.RefinementCtx): void {
  const expected: Readonly<Record<string, { readonly releaseTarget: string; readonly os: string; readonly osVersion: string; readonly arch: string; readonly audiveris: readonly [string, string, string, string]; readonly musescore: readonly [string, string, string, string] }>> = {
    "windows-2022-x64": { releaseTarget: "windows-x64", os: "windows", osVersion: "2022", arch: "x64", audiveris: ["Audiveris-5.11.0-windowsConsole-x86_64.msi", "5f1b4e96a12c53c7da426814b76e599363c4181e291855996e0a6878dda95f71", "msi-admin", "tools/audiveris/bin/Audiveris.exe"], musescore: ["MuseScore-Studio-4.7.4.260706075-x86_64.msi", "64fe70e5cb9ffe159d047d1e88db567bd101f60d36b0de28feb674716929a378", "msi-admin", "tools/musescore/bin/MuseScore4.exe"] },
    "macos-14-x64": { releaseTarget: "darwin-x64", os: "macos", osVersion: "14", arch: "x64", audiveris: ["Audiveris-5.11.0-macosx-x86_64.dmg", "11794424c6f1698617836a77d2c5818c46405a3fe7388281c623c4e383fa33cb", "dmg-copy-app", "tools/audiveris/Audiveris.app/Contents/MacOS/Audiveris"], musescore: ["MuseScore-Studio-4.7.4.260706075.dmg", "e3596e27da0806a3384cab67d52f8478ad21ed2bd6fc96d7cb874d840b016fac", "dmg-copy-app", "tools/musescore/MuseScore Studio.app/Contents/MacOS/mscore"] },
    "macos-14-arm64": { releaseTarget: "darwin-arm64", os: "macos", osVersion: "14", arch: "arm64", audiveris: ["Audiveris-5.11.0-macosx-arm64.dmg", "17491af8b6d40153b031dd1f0815e37213f0999ef23f10586af46706e59b2eb6", "dmg-copy-app", "tools/audiveris/Audiveris.app/Contents/MacOS/Audiveris"], musescore: ["MuseScore-Studio-4.7.4.260706075.dmg", "e3596e27da0806a3384cab67d52f8478ad21ed2bd6fc96d7cb874d840b016fac", "dmg-copy-app", "tools/musescore/MuseScore Studio.app/Contents/MacOS/mscore"] },
    "ubuntu-22.04-x64": { releaseTarget: "linux-x64", os: "ubuntu", osVersion: "22.04", arch: "x64", audiveris: ["Audiveris-5.11.0-ubuntu22.04-x86_64.deb", "ae714594f40e54b1a4951fc3f914f08ae38fe5d07b7f2283b1a904fdb6e0a318", "deb-extract", "tools/audiveris/bin/Audiveris"], musescore: ["MuseScore-Studio-4.7.4.260706075-x86_64.AppImage", "9233ed1b87d3e6b45722278f3c286dcd41e83da778bd0f80a1dd04949696ad93", "appimage-extract", "tools/musescore/AppRun"] },
    "ubuntu-24.04-x64": { releaseTarget: "linux-x64", os: "ubuntu", osVersion: "24.04", arch: "x64", audiveris: ["Audiveris-5.11.0-ubuntu24.04-x86_64.deb", "f20113aaa33b3149ec8d6a09b2a7963360e65fafd92d69389987a85bbc3ec7a3", "deb-extract", "tools/audiveris/bin/Audiveris"], musescore: ["MuseScore-Studio-4.7.4.260706075-x86_64.AppImage", "9233ed1b87d3e6b45722278f3c286dcd41e83da778bd0f80a1dd04949696ad93", "appimage-extract", "tools/musescore/AppRun"] }
  };
  platforms.forEach((platform, index) => {
    const platformExpected = expected[platform.id];
    if (platformExpected === undefined || platform.releaseTarget !== platformExpected.releaseTarget || platform.os !== platformExpected.os || platform.osVersion !== platformExpected.osVersion || platform.arch !== platformExpected.arch) {
      context.addIssue({ code: "custom", path: ["platforms", index], message: "platform coordinates do not match the pinned target" });
      return;
    }
    for (const tool of ["audiveris", "musescore"] as const) {
      const [assetName, sha256, extraction, stagedExecutable] = platformExpected[tool];
      const runtime = platform.runtimes[tool];
      const repository = tool === "audiveris" ? "Audiveris/audiveris" : "musescore/MuseScore";
      const tag = tool === "audiveris" ? "5.11.0" : "v4.7.4";
      const expectedUrl = `https://github.com/${repository}/releases/download/${tag}/${assetName}`;
      const expectedProbe = tool === "audiveris" ? ["-version", "5.11.0"] : ["--version", "4.7.4"];
      if (runtime.assetName !== assetName || runtime.url !== expectedUrl || runtime.sha256 !== sha256 || runtime.extraction !== extraction || runtime.stagedExecutable !== stagedExecutable || runtime.versionProbe.args.join() !== expectedProbe[0] || runtime.versionProbe.expected !== expectedProbe[1]) {
        context.addIssue({ code: "custom", path: ["platforms", index, "runtimes", tool], message: "does not match the pinned official runtime artifact contract" });
      }
    }
  });
}

function validatePinnedMetadata(manifest: z.infer<typeof manifestSchema>, context: z.RefinementCtx): void {
  const toolExpected = {
    audiveris: {
      repositoryUrl: "https://github.com/Audiveris/audiveris",
      archiveUrl: `https://github.com/Audiveris/audiveris/archive/${PINNED.audiverisCommit}.tar.gz`,
      licenseUrl: `https://raw.githubusercontent.com/Audiveris/audiveris/${PINNED.audiverisCommit}/LICENSE`,
      sourcePath: `THIRD_PARTY/sources/audiveris-${PINNED.audiverisCommit}.tar.gz`,
      licensePath: "THIRD_PARTY/licenses/Audiveris-LICENSE"
    },
    musescore: {
      repositoryUrl: "https://github.com/musescore/MuseScore",
      archiveUrl: `https://github.com/musescore/MuseScore/archive/${PINNED.musescoreCommit}.tar.gz`,
      licenseUrl: `https://raw.githubusercontent.com/musescore/MuseScore/${PINNED.musescoreCommit}/LICENSE.txt`,
      sourcePath: `THIRD_PARTY/sources/musescore-${PINNED.musescoreCommit}.tar.gz`,
      licensePath: "THIRD_PARTY/licenses/MuseScore-LICENSE.txt"
    }
  } as const;
  for (const tool of ["audiveris", "musescore"] as const) {
    const actual = manifest.tools[tool];
    const expected = toolExpected[tool];
    if (actual.source.repositoryUrl !== expected.repositoryUrl || actual.source.archiveUrl !== expected.archiveUrl || actual.source.bundledPath !== expected.sourcePath || actual.license.sourceUrl !== expected.licenseUrl || actual.license.bundledPath !== expected.licensePath) {
      context.addIssue({ code: "custom", path: ["tools", tool], message: "source or license metadata does not match the pinned contract" });
    }
  }
  const fonts = manifest.tools.musescore.fonts;
  const expectedFonts = {
    Bravura: ["fonts/bravura", "tools/musescore/fonts/bravura", `https://raw.githubusercontent.com/musescore/MuseScore/${PINNED.musescoreCommit}/fonts/bravura/OFL.txt`, "THIRD_PARTY/fonts/Bravura-OFL.txt"],
    Leland: ["fonts/leland", "tools/musescore/fonts/leland", `https://raw.githubusercontent.com/musescore/MuseScore/${PINNED.musescoreCommit}/fonts/leland/LICENSE.txt`, "THIRD_PARTY/fonts/Leland-LICENSE.txt"]
  } as const;
  for (const font of fonts) {
    const expected = expectedFonts[font.family];
    if (font.sourcePath !== expected[0] || font.bundledPath !== expected[1] || font.license.spdx !== "OFL-1.1" || font.license.sourceUrl !== expected[2] || font.license.bundledPath !== expected[3]) {
      context.addIssue({ code: "custom", path: ["tools", "musescore", "fonts", font.family], message: "font metadata does not match the pinned contract" });
    }
  }
  if (manifest.standards.musicXml.repositoryUrl !== "https://github.com/w3c/musicxml") {
    context.addIssue({ code: "custom", path: ["standards", "musicXml", "repositoryUrl"], message: "schema repository is not pinned" });
  }
  for (const schema of manifest.standards.musicXml.schemas) {
    const expectedUrl = `https://raw.githubusercontent.com/w3c/musicxml/${PINNED.schemaCommit}/${schema.sourcePath}`;
    const expectedPath = `vendor/musicxml-4.0/${schema.sourcePath.slice("schema/".length)}`;
    if (schema.sourceUrl !== expectedUrl || schema.bundledPath !== expectedPath) {
      context.addIssue({ code: "custom", path: ["standards", "musicXml", "schemas", schema.sourcePath], message: "schema metadata does not match the pinned contract" });
    }
  }
}
