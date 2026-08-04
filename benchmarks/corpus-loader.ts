import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { ZodError, type ZodType } from "zod";
import {
  corpusManifestSchema,
  scoreEventsSchema,
  scoreLabelsSchema,
  type CorpusAsset,
  type CorpusManifest,
  type ScoreEvents,
  type ScoreLabels,
} from "./corpus-schema";
export type CorpusLoadErrorCode = "SCHEMA_INVALID" | "PATH_INVALID" | "RIGHTS_INVALID" | "INTEGRITY_INVALID" | "CORPUS_INVALID";
export class CorpusLoadError extends Error {
  readonly name = "CorpusLoadError";
  constructor(
    readonly code: CorpusLoadErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
type VerifiedHashes = Readonly<Record<"sourceSha256" | "labelsSha256" | "eventTraceSha256" | "rightsEvidenceSha256", string>> & {
  readonly maskSha256: readonly string[];
  readonly contentSha256: string;
  readonly groundTruthMusicXmlSha256?: string;
  readonly generatorProvenanceSha256?: string;
};
export type ApprovedCorpusAsset = CorpusAsset & { readonly rights: Extract<CorpusAsset["rights"], { readonly decision: "approved" }> };
export type LoadedCorpusAsset = Readonly<{
  asset: ApprovedCorpusAsset;
  sourcePath: string;
  musicXmlPath?: string;
  labelsPath: string;
  eventTracePath: string;
  rightsEvidencePath: string;
  labels: ScoreLabels;
  eventTrace: ScoreEvents;
  verifiedHashes: VerifiedHashes;
}>;
export type LoadedCorpus = Readonly<{ manifest: CorpusManifest; manifestSha256: string; corpusRoot: string; assets: readonly LoadedCorpusAsset[] }>;
export type LoadScoreCorpusInput = Readonly<{ manifestPath: string; corpusRoot: string; now?: Date }>;
export async function loadScoreCorpus(input: LoadScoreCorpusInput): Promise<LoadedCorpus> {
  const root = await resolveCorpusRoot(input.corpusRoot);
  const manifestFile = await resolveInputFile(root, input.manifestPath);
  const manifestBytes = await readFile(manifestFile);
  const manifest = parseJson(manifestBytes, corpusManifestSchema, "manifest");
  validateManifest(manifest, input.now ?? new Date());
  const assets: LoadedCorpusAsset[] = [];
  for (const asset of manifest.assets) {
    assets.push(await loadAsset(root, asset));
  }
  return { manifest, manifestSha256: sha256(manifestBytes), corpusRoot: root, assets };
}
async function loadAsset(root: string, asset: CorpusAsset): Promise<LoadedCorpusAsset> {
  if (asset.rights.decision !== "approved") {
    throw new CorpusLoadError("RIGHTS_INVALID", `asset ${asset.assetId} is blocked`);
  }
  const approvedAsset: ApprovedCorpusAsset = { ...asset, rights: asset.rights };
  const source = await verifyFile(root, asset.source.relativePath, asset.source.sha256, asset.source.byteLength);
  const labelsFile = await verifyFile(root, asset.labels.relativePath, asset.labels.sha256);
  const eventFile = await verifyFile(root, asset.source.eventTrace.relativePath, asset.source.eventTrace.sha256);
  const evidence = await verifyFile(root, asset.rights.evidence.relativePath, asset.rights.evidence.sha256);
  let contentSha256 = asset.source.contentSha256 ?? source.sha256;
  let musicXmlPath: string | undefined;
  let groundTruthMusicXmlSha256: string | undefined;
  let generatorProvenanceSha256: string | undefined;
  if (asset.source.kind === "generated-local" || asset.source.kind === "local-video") {
    const musicXml = await verifyFile(root, asset.source.generation.musicXml.relativePath, asset.source.generation.musicXml.sha256);
    musicXmlPath = musicXml.path;
    const provenance = await verifyFile(root, asset.source.generation.generator.provenance.relativePath, asset.source.generation.generator.provenance.sha256);
    groundTruthMusicXmlSha256 = musicXml.sha256;
    generatorProvenanceSha256 = provenance.sha256;
    if (asset.source.contentSha256 !== musicXml.sha256) {
      invalidCorpus(`content hash does not match MusicXML for ${asset.assetId}`);
    }
    contentSha256 = musicXml.sha256;
  }
  const labels = parseJson(labelsFile.bytes, scoreLabelsSchema, `labels for ${asset.assetId}`);
  const eventTrace = parseJson(eventFile.bytes, scoreEventsSchema, `events for ${asset.assetId}`);
  validateLabels(asset, labels, groundTruthMusicXmlSha256);
  validateEvents(asset, eventTrace);
  const maskSha256: string[] = [];
  for (const probe of labels.probes) {
    for (const mask of [probe.notationMask, probe.nuisanceMask]) {
      if (mask !== undefined) {
        const verified = await verifyFile(root, mask.relativePath, mask.sha256);
        maskSha256.push(verified.sha256);
      }
    }
  }
  return {
    asset: approvedAsset,
    sourcePath: source.path,
    ...(musicXmlPath === undefined ? {} : { musicXmlPath }),
    labelsPath: labelsFile.path,
    eventTracePath: eventFile.path,
    rightsEvidencePath: evidence.path,
    labels,
    eventTrace,
    verifiedHashes: {
      sourceSha256: source.sha256,
      labelsSha256: labelsFile.sha256,
      eventTraceSha256: eventFile.sha256,
      rightsEvidenceSha256: evidence.sha256,
      contentSha256,
      ...(groundTruthMusicXmlSha256 === undefined ? {} : { groundTruthMusicXmlSha256 }),
      ...(generatorProvenanceSha256 === undefined ? {} : { generatorProvenanceSha256 }),
      maskSha256,
    },
  };
}
function validateManifest(manifest: CorpusManifest, now: Date): void {
  const assetIds = new Set<string>();
  const groups = new Map<string, { readonly split: CorpusAsset["split"]; readonly kind: CorpusAsset["source"]["kind"] }>();
  const contentOwners = new Map<string, string>();
  for (const asset of manifest.assets) {
    requireUnique(assetIds, asset.assetId, "asset ID");
    requireUnique(new Set(asset.classTags), asset.classTags.length, `class tags for ${asset.assetId}`);
    if (asset.source.kind === "synthetic" && asset.split !== "smoke") {
      invalidCorpus(`synthetic asset ${asset.assetId} must use smoke split`);
    }
    if (asset.source.kind === "external-local" && asset.split === "smoke") {
      invalidCorpus(`external asset ${asset.assetId} cannot use smoke split`);
    }
    if ((asset.source.kind === "generated-local" || asset.source.kind === "local-video") && asset.split === "smoke") {
      invalidCorpus(`generated asset ${asset.assetId} cannot use smoke split`);
    }
    const contentSha256 = asset.source.contentSha256 ?? asset.source.sha256;
    const priorContent = contentOwners.get(contentSha256);
    if (priorContent !== undefined && priorContent !== asset.sourceGroupId) {
      invalidCorpus(`content hash leaks across source groups: ${asset.assetId}`);
    }
    contentOwners.set(contentSha256, asset.sourceGroupId);
    const prior = groups.get(asset.sourceGroupId);
    if (prior !== undefined && (prior.split !== asset.split || prior.kind !== asset.source.kind)) {
      invalidCorpus(`source group ${asset.sourceGroupId} leaks across split or source kind`);
    }
    groups.set(asset.sourceGroupId, { split: asset.split, kind: asset.source.kind });
    if (asset.rights.decision !== "approved") {
      throw new CorpusLoadError("RIGHTS_INVALID", `asset ${asset.assetId} is blocked`);
    }
    if ((asset.source.kind === "generated-local" || asset.source.kind === "local-video")
      && (!asset.rights.allowedUses.derivatives || !asset.rights.allowedUses.redistribution)) {
      throw new CorpusLoadError("RIGHTS_INVALID", `generated asset ${asset.assetId} lacks derivative or redistribution permission`);
    }
    if (asset.rights.expiresAt !== undefined && Date.parse(asset.rights.expiresAt) <= now.getTime()) {
      throw new CorpusLoadError("RIGHTS_INVALID", `asset ${asset.assetId} rights are expired`);
    }
  }
}
function validateLabels(asset: CorpusAsset, labels: ScoreLabels, groundTruthMusicXmlSha256?: string): void {
  if (labels.assetId !== asset.assetId || labels.durationMs !== asset.source.durationMs) {
    invalidCorpus(`labels do not match asset ${asset.assetId}`);
  }
  const stateIds = new Set<string>();
  let previousEnd = 0;
  for (const state of labels.states) {
    requireUnique(stateIds, state.stateId, "state ID");
    if (state.startMs < previousEnd || state.startMs >= state.endMs || state.endMs > labels.durationMs) {
      invalidCorpus(`states for ${asset.assetId} are not ordered half-open intervals`);
    }
    previousEnd = state.endMs;
  }
  validateTimestamps(labels.boundaries.map((item) => item.timestampMs), labels.durationMs, "boundaries", asset.assetId);
  validateTimestamps(labels.probes.map((item) => item.timestampMs), labels.durationMs, "probes", asset.assetId);
  for (const probe of labels.probes) {
    if (probe.hasScore !== (probe.scoreRects.length > 0)) {
      invalidCorpus(`probe score presence disagrees for ${asset.assetId}`);
    }
    for (const rect of probe.scoreRects) {
      if (rect.x + rect.width > probe.source.width || rect.y + rect.height > probe.source.height) {
        invalidCorpus(`probe rectangle exceeds source bounds for ${asset.assetId}`);
      }
    }
  }
  const ids = new Set(labels.annotators.map((annotator) => annotator.id));
  if (ids.size !== labels.annotators.length) {
    invalidCorpus(`annotator IDs must be distinct for ${asset.assetId}`);
  }
  if (asset.source.kind === "external-local") {
    const annotators = labels.annotators.filter((entry) => entry.role === "annotator").length;
    const adjudicators = labels.annotators.filter((entry) => entry.role === "adjudicator").length;
    if (annotators < 2 || adjudicators < 1) {
      invalidCorpus(`external labels require two annotators and one adjudicator for ${asset.assetId}`);
    }
  }
  if (asset.source.kind === "generated-local" || asset.source.kind === "local-video") {
    if (labels.oracle === undefined || groundTruthMusicXmlSha256 === undefined
      || labels.oracle.groundTruthMusicXmlSha256 !== groundTruthMusicXmlSha256) {
      invalidCorpus(`oracle MusicXML hash does not match generated asset ${asset.assetId}`);
    }
    if (labels.oracle !== undefined && labels.oracle.expectedPageOrder.length !== labels.oracle.expectedPageCount) {
      invalidCorpus(`oracle page order does not match page count for ${asset.assetId}`);
    }
    if (labels.oracle !== undefined && (labels.oracle.expectedStaffCounts.length !== labels.oracle.expectedPageCount
      || labels.oracle.expectedSystemCounts.length !== labels.oracle.expectedPageCount)) {
      invalidCorpus(`oracle page facts do not match page count for ${asset.assetId}`);
    }
  }
}
function validateEvents(asset: CorpusAsset, events: ScoreEvents): void {
  if (events.assetId !== asset.assetId) {
    invalidCorpus(`events do not match asset ${asset.assetId}`);
  }
  validateTimestamps(events.events.map((event) => event.timestampMs), asset.source.durationMs, "events", asset.assetId);
}
function validateTimestamps(values: readonly number[], durationMs: number, label: string, assetId: string): void {
  for (const value of values) {
    if (value >= durationMs) {
      invalidCorpus(`${label} for ${assetId} are out of bounds`);
    }
  }
}
async function resolveCorpusRoot(input: string): Promise<string> {
  const lexical = resolve(input);
  const stat = await lstat(lexical).catch((error: unknown) => pathFailure("corpus root is unavailable", error));
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new CorpusLoadError("PATH_INVALID", "corpus root must be a real directory");
  }
  return realpath(lexical).catch((error: unknown) => pathFailure("corpus root cannot be resolved", error));
}
async function resolveInputFile(root: string, input: string): Promise<string> {
  const lexical = resolve(input);
  const canonical = await realpath(lexical).catch((error: unknown) => pathFailure("manifest cannot be resolved", error));
  if (!insideRoot(root, canonical)) {
    throw new CorpusLoadError("PATH_INVALID", "manifest must be inside corpus root");
  }
  return resolveExistingFile(root, canonical);
}
async function verifyFile(root: string, relativePath: string, expectedSha256: string, expectedLength?: number): Promise<VerifiedFile> {
  if (isAbsolute(relativePath) || win32.isAbsolute(relativePath) || relativePath.includes("\\")) {
    throw new CorpusLoadError("PATH_INVALID", `invalid local path: ${relativePath}`);
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new CorpusLoadError("PATH_INVALID", `invalid local path: ${relativePath}`);
  }
  const path = await resolveExistingFile(root, resolve(root, ...segments));
  const bytes = await readFile(path);
  const digest = sha256(bytes);
  if (digest !== expectedSha256 || (expectedLength !== undefined && bytes.byteLength !== expectedLength)) {
    throw new CorpusLoadError("INTEGRITY_INVALID", `integrity mismatch: ${relativePath}`);
  }
  return { path, bytes, sha256: digest };
}
async function resolveExistingFile(root: string, lexical: string): Promise<string> {
  if (!insideRoot(root, lexical)) {
    throw new CorpusLoadError("PATH_INVALID", "local path escapes corpus root");
  }
  const stat = await lstat(lexical).catch((error: unknown) => pathFailure("local file is unavailable", error));
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new CorpusLoadError("PATH_INVALID", "local path must name a regular non-symlink file");
  }
  const resolved = await realpath(lexical).catch((error: unknown) => pathFailure("local file cannot be resolved", error));
  if (!insideRoot(root, resolved)) {
    throw new CorpusLoadError("PATH_INVALID", "local file resolves outside corpus root");
  }
  return resolved;
}
function parseJson<T>(bytes: Buffer, schema: ZodType<T>, label: string): T {
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) {
      throw new CorpusLoadError("SCHEMA_INVALID", `${label} is invalid`, { cause: error });
    }
    throw error;
  }
}
type VerifiedFile = { readonly path: string; readonly bytes: Buffer; readonly sha256: string };
function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
function insideRoot(root: string, candidate: string): boolean {
  return candidate !== root && !relative(root, candidate).startsWith(`..${sep}`) && relative(root, candidate) !== ".." && !isAbsolute(relative(root, candidate));
}
function requireUnique(values: Set<string>, value: string | number, label: string): void {
  if (typeof value === "number" ? values.size !== value : values.has(value)) {
    invalidCorpus(`duplicate ${label}: ${value}`);
  }
  if (typeof value === "string") {
    values.add(value);
  }
}
function invalidCorpus(message: string): never {
  throw new CorpusLoadError("CORPUS_INVALID", message);
}
function pathFailure(message: string, cause: unknown): never {
  throw new CorpusLoadError("PATH_INVALID", message, { cause });
}
