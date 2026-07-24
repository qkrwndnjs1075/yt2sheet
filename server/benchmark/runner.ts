import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { CorpusLoadError, loadScoreCorpus, type LoadedCorpusAsset } from "./corpus-loader";
import {
  aggregateAssetValuesBySourceGroup,
  bootstrapPairedGroupDeltas,
  computeBoundaryRecall,
  computeUniqueStateRecall,
  evaluatePromotion,
  type AssetMetricValue,
  type BenchmarkGroupEligibility,
  type BootstrapInterval,
} from "./metrics";
import { buildControlSamplingPlan, buildTreatmentTimestamps } from "./sampling-plan";

const executeFile = promisify(execFile);
const REQUIRED_TAGS = ["static", "cursor", "scroll", "hard-turn", "fade", "compression", "no-score"] as const;
const planSchema = z.object({
  schemaVersion: z.literal("score-benchmark-plan/1"), planId: z.literal("score-pipeline-v1"), seed: z.literal(20_260_724),
  bootstrapResamples: z.literal(10_000), boundaryWindowMs: z.literal(500), eventThreshold: z.literal(12),
  nmsWindowMs: z.literal(500), eventOffsetsMs: z.tuple([z.literal(-250), z.literal(0), z.literal(250)]),
  maxCandidates: z.literal(3_600), requiredClassTags: z.tuple([
    z.literal("static"), z.literal("cursor"), z.literal("scroll"), z.literal("hard-turn"),
    z.literal("fade"), z.literal("compression"), z.literal("no-score"),
  ]),
  promotion: z.object({ minGroups: z.literal(30), minCalibrationGroups: z.literal(10), minTestGroups: z.literal(20),
    minTestGroupsPerRequiredTag: z.literal(5), stateRecallLower95Min: z.literal(0), boundaryRecallLower95Min: z.literal(0),
    candidateDeltaUpper95Max: z.literal(0) }).strict(),
}).strict();

type BenchmarkCase = Readonly<{
  schemaVersion: "score-benchmark-case/1"; runDigest: string; assetId: string; sourceGroupId: string;
  split: "smoke" | "calibration" | "test"; classTags: readonly string[]; budget: number;
  control: Readonly<{ candidateCount: number; stateRecall: number | null; boundaryRecall: number | null; runtimeMs: 0 }>;
  treatment: Readonly<{ candidateCount: number; stateRecall: number | null; boundaryRecall: number | null; runtimeMs: 0 }>;
  candidateDelta: number; withinBudget: boolean;
}>;
type RunInput = Readonly<{ manifestPath: string; planPath: string; corpusRoot: string; outputRoot: string; seed?: number }>;
export type RunResult = Readonly<{ runDigest: string; outputDirectory: string; exitCode: 0 | 4 }>;
export class BenchmarkRunError extends Error {
  readonly name = "BenchmarkRunError";
  constructor(readonly code: "VALIDATION" | "RUNTIME" | "OVERWRITE", message: string, options?: ErrorOptions) { super(message, options); }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export async function runScoreBenchmark(input: RunInput): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const projectRoot = resolve(".");
  try {
    const { planBytes, plan } = await readPlan(input.planPath);
    const effectiveSeed = input.seed ?? plan.seed;
    if (!Number.isInteger(effectiveSeed) || effectiveSeed < 0 || effectiveSeed > 0xffff_ffff) {
      throw new BenchmarkRunError("VALIDATION", "Seed must be an unsigned 32-bit integer.");
    }
    const corpus = await loadScoreCorpus({ manifestPath: input.manifestPath, corpusRoot: input.corpusRoot });
    const toolVersions = await readToolVersions(projectRoot);
    const sourceHashes = corpus.assets.map(({ asset, verifiedHashes }) => ({ assetId: asset.assetId, sha256: verifiedHashes.sourceSha256 }))
      .sort((left, right) => compareText(left.assetId, right.assetId));
    const benchmarkModuleHashes = await readModuleHashes(projectRoot);
    const planSha256 = sha256(planBytes);
    const runDigest = sha256(Buffer.from(canonicalJson({ schemaVersion: "score-benchmark-run/1", manifestSha256: corpus.manifestSha256,
      planSha256, orderedSourceHashes: sourceHashes, orderedBenchmarkModuleHashes: benchmarkModuleHashes, toolVersions, seed: effectiveSeed })));
    const provisional = corpus.assets.map((asset) => buildCase(asset, runDigest));
    const cases = provisional.sort((left, right) => compareText(left.row.assetId, right.row.assetId)
      || left.earliestTimestamp - right.earliestTimestamp || compareText(left.row.sourceGroupId, right.row.sourceGroupId)).map(({ row }) => row);
    const claimTier = corpus.assets.some(({ asset }) => asset.source.kind === "external-local" && asset.split === "test")
      ? "external-gated" as const : "mechanics-only" as const;
    const groups: readonly BenchmarkGroupEligibility[] = corpus.assets.map(({ asset }) => ({ sourceGroupId: asset.sourceGroupId,
      split: asset.split, approved: true, classTags: asset.classTags }));
    const bootstrap = buildBootstrap(cases, effectiveSeed);
    const promotion = evaluatePromotion({ claimTier, groups, calibrationTunedDuringRun: false,
      everyCaseWithinBudget: cases.every((entry) => entry.withinBudget), bootstrap });
    const summary = buildSummary({ cases, runDigest, bootstrap, promotion });
    const run = { schemaVersion: "score-benchmark-run/1", runDigest, status: "completed", claimTier,
      qualityClaimsAllowed: promotion.qualityClaimsAllowed, manifestSha256: corpus.manifestSha256, planSha256, effectiveSeed,
      sourceHashes, benchmarkModuleHashes, toolVersions };
    const rightsAudit = { schemaVersion: "score-rights-audit/1", runDigest, assets: corpus.assets.map(({ asset, verifiedHashes }) => ({
      assetId: asset.assetId, decision: asset.rights.decision, basis: asset.rights.basis,
      evidenceSha256: verifiedHashes.rightsEvidenceSha256, redistribution: asset.rights.allowedUses.redistribution,
      ...(asset.rights.expiresAt === undefined ? {} : { expiresAt: asset.rights.expiresAt }),
    })).sort((left, right) => compareText(left.assetId, right.assetId)) };
    const outputRoot = resolve(input.outputRoot);
    await mkdir(outputRoot, { recursive: true });
    const outputDirectory = resolve(outputRoot, runDigest);
    try { await mkdir(outputDirectory); } catch (error) {
      if (errorCode(error) === "EEXIST") throw new BenchmarkRunError("OVERWRITE", "Benchmark digest directory already exists.", { cause: error });
      throw error;
    }
    const failures = [
      ...(claimTier === "external-gated" && !promotion.eligible
        ? [{ schemaVersion: "score-benchmark-failure/1" as const, runDigest, code: "EXTERNAL_INELIGIBLE", message: "external-eligibility" }]
        : []),
      ...promotion.gateFailures.map((gate) => ({ schemaVersion: "score-benchmark-failure/1" as const, runDigest,
        code: "PROMOTION_GATE_FAILED", message: gate })),
    ].sort(compareFailures);
    await Promise.all([
      writeFile(resolve(outputDirectory, "run.json"), canonicalJson(run)),
      writeFile(resolve(outputDirectory, "rights-audit.json"), canonicalJson(rightsAudit)),
      writeFile(resolve(outputDirectory, "cases.jsonl"), jsonLines(cases)),
      writeFile(resolve(outputDirectory, "summary.json"), canonicalJson(summary)),
      writeFile(resolve(outputDirectory, "failures.jsonl"), jsonLines(failures)),
      writeFile(resolve(outputDirectory, "run-volatile.json"), canonicalJson({ schemaVersion: "score-benchmark-run-volatile/1",
        runDigest, startedAt, endedAt: new Date().toISOString(), outputRoot })),
    ]);
    return { runDigest, outputDirectory, exitCode: promotion.exitCode };
  } catch (error) {
    if (error instanceof BenchmarkRunError) throw error;
    if (error instanceof CorpusLoadError) {
      throw new BenchmarkRunError("VALIDATION", "Benchmark input validation failed.", { cause: error });
    }
    throw new BenchmarkRunError("RUNTIME", "Benchmark execution failed.", { cause: error });
  }
}

async function readPlan(planPath: string) {
  try {
    const planBytes = await readFile(resolve(planPath));
    return { planBytes, plan: planSchema.parse(JSON.parse(planBytes.toString("utf8"))) };
  } catch (error) {
    throw new BenchmarkRunError("VALIDATION", "Benchmark input validation failed.", { cause: error });
  }
}

function buildCase(entry: LoadedCorpusAsset, runDigest: string): { readonly row: BenchmarkCase; readonly earliestTimestamp: number } {
  const { asset, labels, eventTrace } = entry;
  const controlPlan = buildControlSamplingPlan(asset.source.durationMs);
  const treatmentTimestamps = buildTreatmentTimestamps(asset.source.durationMs, eventTrace);
  const controlState = computeUniqueStateRecall(controlPlan.timestampsMs, labels.states).ratio;
  const treatmentState = computeUniqueStateRecall(treatmentTimestamps, labels.states).ratio;
  const controlBoundary = computeBoundaryRecall(controlPlan.timestampsMs, labels.boundaries).ratio;
  const treatmentBoundary = computeBoundaryRecall(treatmentTimestamps, labels.boundaries).ratio;
  return { earliestTimestamp: Math.min(controlPlan.timestampsMs[0] ?? 0, treatmentTimestamps[0] ?? 0), row: {
    schemaVersion: "score-benchmark-case/1", runDigest, assetId: asset.assetId, sourceGroupId: asset.sourceGroupId,
    split: asset.split, classTags: asset.classTags, budget: controlPlan.budget,
    control: { candidateCount: controlPlan.timestampsMs.length, stateRecall: controlState, boundaryRecall: controlBoundary, runtimeMs: 0 },
    treatment: { candidateCount: treatmentTimestamps.length, stateRecall: treatmentState, boundaryRecall: treatmentBoundary, runtimeMs: 0 },
    candidateDelta: treatmentTimestamps.length - controlPlan.timestampsMs.length, withinBudget: treatmentTimestamps.length <= controlPlan.budget,
  } };
}

function buildBootstrap(cases: readonly BenchmarkCase[], seed: number) {
  const testCases = cases.filter((entry) => entry.split === "test");
  const deltas = (select: (entry: BenchmarkCase) => number | null): readonly (number | null)[] =>
    aggregateAssetValuesBySourceGroup(testCases.map((entry) => ({ assetId: entry.assetId, sourceGroupId: entry.sourceGroupId, value: select(entry) })))
      .groups.map((group) => group.value);
  return { stateRecall: bootstrapPairedGroupDeltas(deltas((entry) => nullableDelta(entry.treatment.stateRecall, entry.control.stateRecall)), seed),
    boundaryRecall: bootstrapPairedGroupDeltas(deltas((entry) => nullableDelta(entry.treatment.boundaryRecall, entry.control.boundaryRecall)), seed),
    candidateDelta: bootstrapPairedGroupDeltas(deltas((entry) => entry.candidateDelta), seed) };
}

function buildSummary(input: Readonly<{ cases: readonly BenchmarkCase[]; runDigest: string;
  bootstrap: Readonly<Record<string, BootstrapInterval>>;
  promotion: Readonly<{ eligible: boolean; promotionPassed: boolean; gateFailures: readonly string[] }> }>) {
  const { cases, runDigest, bootstrap, promotion } = input;
  const groupSplits = new Map(cases.map((entry) => [entry.sourceGroupId, entry.split]));
  const splitGroupCounts = { smoke: 0, calibration: 0, test: 0 };
  for (const split of groupSplits.values()) splitGroupCounts[split] += 1;
  const requiredTagTestGroupCounts = Object.fromEntries(REQUIRED_TAGS.map((tag) => [tag,
    new Set(cases.filter((entry) => entry.split === "test" && entry.classTags.includes(tag)).map((entry) => entry.sourceGroupId)).size]));
  const macroValue = (select: (entry: BenchmarkCase) => number | null): number | null =>
    aggregateAssetValuesBySourceGroup(cases.map((entry) => ({ assetId: entry.assetId, sourceGroupId: entry.sourceGroupId, value: select(entry) }))).macro;
  const metricMacro = (kind: "control" | "treatment") => ({ candidateCount: macroValue((entry) => entry[kind].candidateCount),
    stateRecall: macroValue((entry) => entry[kind].stateRecall), boundaryRecall: macroValue((entry) => entry[kind].boundaryRecall),
    runtimeMs: macroValue((entry) => entry[kind].runtimeMs) });
  return { schemaVersion: "score-benchmark-summary/1", runDigest, groupCount: groupSplits.size, splitGroupCounts,
    requiredTagTestGroupCounts, macro: { control: metricMacro("control"), treatment: metricMacro("treatment"),
      candidateDelta: macroValue((entry) => entry.candidateDelta) }, bootstrap, eligible: promotion.eligible,
    promotionPassed: promotion.promotionPassed, gateFailures: promotion.gateFailures };
}

async function readModuleHashes(projectRoot: string): Promise<readonly { readonly relativePath: string; readonly sha256: string }[]> {
  const names = (await readdir(resolve(projectRoot, "server/benchmark"))).filter((name) => name.endsWith(".ts"));
  const relativePaths = [...names.map((name) => `server/benchmark/${name}`), "server/youtube-score-processor.ts"].sort();
  return Promise.all(relativePaths.map(async (relativePath) => ({ relativePath, sha256: sha256(await readFile(resolve(projectRoot, relativePath))) })));
}

async function readToolVersions(projectRoot: string) {
  const { stdout } = await executeFile("ffmpeg", ["-version"], { windowsHide: true });
  const firstLine = stdout.split(/\r?\n/, 1)[0]?.trim().split(/\s+/);
  if (firstLine?.[0] !== "ffmpeg" || firstLine[1] !== "version" || firstLine[2] === undefined) throw new BenchmarkRunError("RUNTIME", "Unable to parse ffmpeg version.");
  const sharpPackage: unknown = JSON.parse(await readFile(resolve(projectRoot, "node_modules/sharp/package.json"), "utf8"));
  const sharp = z.object({ version: z.string().min(1) }).passthrough().parse(sharpPackage).version;
  return { node: process.versions.node, ffmpeg: firstLine[2], sharp };
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new BenchmarkRunError("VALIDATION", "Canonical JSON rejects non-finite numbers.");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => compareText(left, right))
    .map(([key, entry]) => [key, canonicalValue(entry)]));
  throw new BenchmarkRunError("VALIDATION", "Canonical JSON received an unsupported value.");
}
function sha256(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function nullableDelta(treatment: number | null, control: number | null): number | null { return treatment === null || control === null ? null : treatment - control; }
function jsonLines(values: readonly unknown[]): string { return values.length === 0 ? "" : `${values.map(canonicalJson).join("\n")}\n`; }
function errorCode(error: unknown): unknown { return typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined; }
function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function compareFailures(left: { readonly assetId?: string; readonly code: string; readonly message: string }, right: { readonly assetId?: string; readonly code: string; readonly message: string }): number {
  return compareText(left.assetId ?? "", right.assetId ?? "") || compareText(left.code, right.code) || compareText(left.message, right.message);
}
