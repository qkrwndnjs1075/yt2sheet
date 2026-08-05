import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { join, resolve } from "node:path";
import { zipSync } from "fflate";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { promisify } from "node:util";
import { z } from "zod";
import { CorpusLoadError, loadScoreCorpus, type LoadedCorpusAsset } from "./corpus-loader";
import {
  aggregateAssetValuesBySourceGroup,
  bootstrapPairedGroupDeltas,
  computeBoundaryRecall,
  computeStructuredPrecision,
  computeUniqueStateRecall,
  evaluatePromotion,
  type AssetMetricValue,
  type BenchmarkGroupEligibility,
  type BootstrapInterval,
} from "./metrics";
import { buildControlSamplingPlan, buildTreatmentTimestamps } from "./sampling-plan";
import { LocalVideoScoreProcessor, type LocalVideoJobInput, type ReviewedPipeline } from "../pipeline/youtube-score-processor";
import { defaultMediaTools } from "../pipeline/media-tools";
import { RASTER_REVIEW_POLICY_DIGEST } from "../pipeline/score-raster-review";
import type { AudiverisApprovedPage, AudiverisPageMxl } from "../pipeline/audiveris-adapter";
import type { MuseScorePageInput } from "../pipeline/musescore-adapter";

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
  generator: z.object({ name: z.literal("verovio"), version: z.literal("6.1.0"), thresholdsFrozenAfterCalibration: z.literal(true) }).strict(),
  budgets: z.object({ maxRuntimeMs: z.literal(15_000), maxPages: z.literal(16), maxOutputBytes: z.literal(5_000_000) }).strict(),
  promotion: z.object({ minGroups: z.literal(30), minCalibrationGroups: z.literal(10), minTestGroups: z.literal(20),
    minTestGroupsPerRequiredTag: z.literal(5), stateRecallLower95Min: z.literal(0), boundaryRecallLower95Min: z.literal(0),
    candidateDeltaUpper95Max: z.literal(0), structuredPrecisionMin: z.literal(1), fallbackRecallMin: z.literal(1),
    falseHardBlocksMax: z.literal(0), finalPageValidationMin: z.literal(1), requireCompletedCases: z.literal(true) }).strict(),
}).strict();

type BenchmarkBudgets = Readonly<{ maxRuntimeMs: number; maxPages: number; maxOutputBytes: number }>;
type CaseBudget = Readonly<{ runtimeMs: number; outputBytes: number; maxRuntimeMs: number; maxPages: number; maxOutputBytes: number; withinBudget: boolean }>;
type BenchmarkCase = Readonly<{
  schemaVersion: "score-benchmark-case/1"; runDigest: string; assetId: string; sourceGroupId: string;
  split: "smoke" | "calibration" | "test"; classTags: readonly string[]; budget: number;
  control: Readonly<{ candidateCount: number; stateRecall: number | null; boundaryRecall: number | null; runtimeMs: number }>;
  treatment: Readonly<{ candidateCount: number; stateRecall: number | null; boundaryRecall: number | null; runtimeMs: number }>;
  candidateDelta: number; withinBudget: boolean;
  execution: Readonly<{
    pipelineExecution: "completed" | "failed";
    disposition: "blocked" | "structured" | "raster-fallback" | null;
    pageCount: number | null;
    pageOrder: readonly number[];
    staffCounts: readonly number[];
    systemCounts: readonly number[];
    finalPageValidation: number;
    artifactDirectory: string | null;
    artifactSha256: string | null;
    runtimeMs: number;
    outputBytes: number | null;
    budget: CaseBudget;
    errorCode?: string;
  }>;
}>;
type BenchmarkEvidence = Readonly<{
  schemaVersion: "score-benchmark-evidence/1"; runDigest: string; assetId: string; sourceGroupId: string;
  split: "smoke" | "calibration" | "test"; classTags: readonly string[]; variant: "control" | "treatment";
  sampling: Readonly<{ budget: number; timestampsMs: readonly number[]; candidateCount: number }>;
  pipelineExecution: "completed" | "failed";
  artifact: Readonly<{ relativePath: string; sha256: string; pageCount: number | null }>;
  execution?: Readonly<{ disposition: "blocked" | "structured" | "raster-fallback" | null; runtimeMs: number; outputBytes: number | null; budget: CaseBudget; errorCode?: string }>;
}>;
type RunInput = Readonly<{ manifestPath: string; planPath: string; corpusRoot: string; outputRoot: string; seed?: number; signal?: AbortSignal }>;
export type RunResult = Readonly<{ runDigest: string; outputDirectory: string; exitCode: 0 | 4 }>;
export class BenchmarkRunError extends Error {
  readonly name = "BenchmarkRunError";
  constructor(readonly code: "VALIDATION" | "RUNTIME" | "OVERWRITE", message: string, options?: ErrorOptions) { super(message, options); }
}
class BenchmarkCaseError extends Error {
  readonly name = "BenchmarkCaseError";
  constructor(readonly code: "PAGE_BUDGET_EXCEEDED") { super(code); }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export async function runScoreBenchmark(input: RunInput): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const projectRoot = resolve(".");
  let outputDirectoryForCleanup: string | undefined;
  try {
    const { planBytes, plan } = await readPlan(input.planPath);
    const effectiveSeed = input.seed ?? plan.seed;
    if (!Number.isInteger(effectiveSeed) || effectiveSeed < 0 || effectiveSeed > 0xffff_ffff) {
      throw new BenchmarkRunError("VALIDATION", "Seed must be an unsigned 32-bit integer.");
    }
    const corpus = await loadScoreCorpus({ manifestPath: input.manifestPath, corpusRoot: input.corpusRoot });
    const toolVersions = await readToolVersions(projectRoot);
    const sourceHashes = corpus.assets.map(({ asset, verifiedHashes }) => ({ assetId: asset.assetId, sourceGroupId: asset.sourceGroupId,
      split: asset.split, sha256: verifiedHashes.sourceSha256, contentSha256: verifiedHashes.contentSha256,
      ...(verifiedHashes.groundTruthMusicXmlSha256 === undefined ? {} : { groundTruthMusicXmlSha256: verifiedHashes.groundTruthMusicXmlSha256 }) }))
      .sort((left, right) => compareText(left.assetId, right.assetId));
    const benchmarkModuleHashes = await readModuleHashes(projectRoot);
    const planSha256 = sha256(planBytes);
    const runDigest = sha256(Buffer.from(canonicalJson({ schemaVersion: "score-benchmark-run/1", manifestSha256: corpus.manifestSha256,
      planSha256, orderedSourceHashes: sourceHashes, orderedBenchmarkModuleHashes: benchmarkModuleHashes, toolVersions, seed: effectiveSeed })));
    const budgets: BenchmarkBudgets = plan.budgets;
    const provisional = corpus.assets.map((asset) => buildCase(asset, runDigest, budgets));
    const orderedProvisional = provisional.sort((left, right) => compareText(left.row.assetId, right.row.assetId)
      || left.earliestTimestamp - right.earliestTimestamp || compareText(left.row.sourceGroupId, right.row.sourceGroupId));
    const claimTier = corpus.assets.some(({ asset }) => (asset.source.kind === "external-local" || asset.source.kind === "generated-local" || asset.source.kind === "local-video") && asset.split === "test")
      ? "external-gated" as const : "mechanics-only" as const;
    const groups: readonly BenchmarkGroupEligibility[] = corpus.assets.map(({ asset }) => ({ sourceGroupId: asset.sourceGroupId,
      split: asset.split, approved: true, classTags: asset.classTags }));
    const outputRoot = resolve(input.outputRoot);
    await mkdir(outputRoot, { recursive: true });
    const outputDirectory = resolve(outputRoot, runDigest);
    outputDirectoryForCleanup = outputDirectory;
    try { await mkdir(outputDirectory); } catch (error) {
      if (errorCode(error) === "EEXIST") {
        const missingArtifacts = await findMissingArtifacts(outputDirectory);
        if (missingArtifacts.length > 0) {
          throw new BenchmarkRunError("VALIDATION", `Benchmark artifact integrity failed: ${missingArtifacts.join(",")}`, { cause: error });
        }
        throw new BenchmarkRunError("OVERWRITE", "Benchmark digest directory already exists.", { cause: error });
      }
      throw error;
    }
    const executed = [];
    for (const entry of orderedProvisional) {
      if (input.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
      executed.push(await executeCase(entry, outputDirectory, budgets, input.signal));
    }
    const cases = executed.map((entry) => entry.row);
    const evidence = executed.flatMap((entry) => entry.evidence).sort((left, right) =>
      compareText(left.assetId, right.assetId) || compareText(left.variant, right.variant));
    const bootstrap = buildBootstrap(cases, effectiveSeed);
    const executionMetrics = summarizeExecution(cases, corpus.assets);
    const promotion = evaluatePromotion({ claimTier, groups, calibrationTunedDuringRun: false,
      everyCaseWithinBudget: cases.every((entry) => entry.withinBudget),
      rightsAndHashesValid: executionMetrics.rightsAndHashesValid,
      sourceGroupsIsolated: executionMetrics.sourceGroupsIsolated,
      allCasesExecuted: executionMetrics.allCasesExecuted,
      artifactsComplete: executionMetrics.artifactsComplete,
      oracleMatches: executionMetrics.oracleMatches,
      structuredPrecision: executionMetrics.structuredPrecision,
      fallbackRecall: executionMetrics.fallbackRecall,
      falseHardBlocks: executionMetrics.falseHardBlocks,
      finalPageValidation: executionMetrics.finalPageValidation,
      bootstrap });
    const summary = buildSummary({ cases, runDigest, bootstrap, promotion, executionMetrics });
    const run = { schemaVersion: "score-benchmark-run/1", runDigest, status: "completed", claimTier,
      qualityClaimsAllowed: promotion.qualityClaimsAllowed, manifestSha256: corpus.manifestSha256, planSha256, effectiveSeed,
      sourceHashes, benchmarkModuleHashes, toolVersions,
      generator: plan.generator, thresholdsFrozenAfterCalibration: plan.generator.thresholdsFrozenAfterCalibration };
    const rightsAudit = { schemaVersion: "score-rights-audit/1", runDigest, assets: corpus.assets.map(({ asset, verifiedHashes }) => ({
      assetId: asset.assetId, decision: asset.rights.decision, basis: asset.rights.basis,
      evidenceSha256: verifiedHashes.rightsEvidenceSha256, redistribution: asset.rights.allowedUses.redistribution,
      contentSha256: verifiedHashes.contentSha256,
      ...(verifiedHashes.groundTruthMusicXmlSha256 === undefined ? {} : { groundTruthMusicXmlSha256: verifiedHashes.groundTruthMusicXmlSha256 }),
      ...(asset.rights.expiresAt === undefined ? {} : { expiresAt: asset.rights.expiresAt }),
    })).sort((left, right) => compareText(left.assetId, right.assetId)) };
    const failures = [
      ...(claimTier === "external-gated" && !promotion.eligible
        ? [{ schemaVersion: "score-benchmark-failure/1" as const, runDigest, code: "EXTERNAL_INELIGIBLE", message: "external-eligibility" }]
        : []),
      ...executionMetrics.failedCaseIds.map((assetId) => ({ schemaVersion: "score-benchmark-failure/1" as const, runDigest,
        code: "CASE_EXECUTION_FAILED", assetId, message: `case-execution-failed:${assetId}` })),
      ...promotion.gateFailures.map((gate) => ({ schemaVersion: "score-benchmark-failure/1" as const, runDigest,
        code: "PROMOTION_GATE_FAILED", message: gate })),
    ].sort(compareFailures);
    await Promise.all([
      writeFile(resolve(outputDirectory, "run.json"), canonicalJson(run)),
      writeFile(resolve(outputDirectory, "rights-audit.json"), canonicalJson(rightsAudit)),
      writeFile(resolve(outputDirectory, "cases.jsonl"), jsonLines(cases)),
      writeFile(resolve(outputDirectory, "evidence.jsonl"), jsonLines(evidence)),
      writeFile(resolve(outputDirectory, "summary.json"), canonicalJson(summary)),
      writeFile(resolve(outputDirectory, "failures.jsonl"), jsonLines(failures)),
      writeFile(resolve(outputDirectory, "run-volatile.json"), canonicalJson({ schemaVersion: "score-benchmark-run-volatile/1",
        runDigest, startedAt, endedAt: new Date().toISOString(), outputRoot })),
    ]);
    return { runDigest, outputDirectory, exitCode: promotion.exitCode };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      if (outputDirectoryForCleanup !== undefined) await rm(outputDirectoryForCleanup, { recursive: true, force: true });
      throw new BenchmarkRunError("RUNTIME", "Benchmark execution cancelled.", { cause: error });
    }
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

function buildCase(entry: LoadedCorpusAsset, runDigest: string, budgets: BenchmarkBudgets): {
  readonly asset: LoadedCorpusAsset; readonly row: BenchmarkCase; readonly earliestTimestamp: number; readonly evidence: readonly BenchmarkEvidence[];
} {
  const { asset, labels, eventTrace } = entry;
  const controlStartedAt = performance.now();
  const controlPlan = buildControlSamplingPlan(asset.source.durationMs);
  const treatmentTimestamps = buildTreatmentTimestamps(asset.source.durationMs, eventTrace);
  const controlState = computeUniqueStateRecall(controlPlan.timestampsMs, labels.states).ratio;
  const controlBoundary = computeBoundaryRecall(controlPlan.timestampsMs, labels.boundaries).ratio;
  const controlRuntimeMs = measuredMs(controlStartedAt, performance.now());
  const treatmentStartedAt = performance.now();
  const treatmentState = computeUniqueStateRecall(treatmentTimestamps, labels.states).ratio;
  const treatmentBoundary = computeBoundaryRecall(treatmentTimestamps, labels.boundaries).ratio;
  const treatmentRuntimeMs = measuredMs(treatmentStartedAt, performance.now());
  const initialBudget: CaseBudget = { runtimeMs: 0, outputBytes: 0, maxRuntimeMs: budgets.maxRuntimeMs,
    maxPages: budgets.maxPages, maxOutputBytes: budgets.maxOutputBytes, withinBudget: false };
  return {
    asset: entry,
    earliestTimestamp: Math.min(controlPlan.timestampsMs[0] ?? 0, treatmentTimestamps[0] ?? 0),
    row: {
      schemaVersion: "score-benchmark-case/1", runDigest, assetId: asset.assetId, sourceGroupId: asset.sourceGroupId,
      split: asset.split, classTags: asset.classTags, budget: controlPlan.budget,
      control: { candidateCount: controlPlan.timestampsMs.length, stateRecall: controlState, boundaryRecall: controlBoundary, runtimeMs: controlRuntimeMs },
      treatment: { candidateCount: treatmentTimestamps.length, stateRecall: treatmentState, boundaryRecall: treatmentBoundary, runtimeMs: treatmentRuntimeMs },
      candidateDelta: treatmentTimestamps.length - controlPlan.timestampsMs.length, withinBudget: treatmentTimestamps.length <= controlPlan.budget,
      execution: { pipelineExecution: "failed", disposition: null, pageCount: null, pageOrder: [], staffCounts: [], systemCounts: [], finalPageValidation: 0,
        artifactDirectory: null, artifactSha256: null, runtimeMs: 0, outputBytes: null, budget: initialBudget, errorCode: "NOT_EXECUTED" },
    },
    evidence: [
      {
        schemaVersion: "score-benchmark-evidence/1", runDigest, assetId: asset.assetId, sourceGroupId: asset.sourceGroupId,
        split: asset.split, classTags: asset.classTags, variant: "control",
        sampling: { budget: controlPlan.budget, timestampsMs: controlPlan.timestampsMs, candidateCount: controlPlan.timestampsMs.length },
        pipelineExecution: "failed",
        artifact: { relativePath: "", sha256: "0".repeat(64), pageCount: null },
        execution: { disposition: null, runtimeMs: 0, outputBytes: null, budget: initialBudget, errorCode: "NOT_EXECUTED" },
      },
      {
        schemaVersion: "score-benchmark-evidence/1", runDigest, assetId: asset.assetId, sourceGroupId: asset.sourceGroupId,
        split: asset.split, classTags: asset.classTags, variant: "treatment",
        sampling: { budget: controlPlan.budget, timestampsMs: treatmentTimestamps, candidateCount: treatmentTimestamps.length },
        pipelineExecution: "failed",
        artifact: { relativePath: "", sha256: "0".repeat(64), pageCount: null },
        execution: { disposition: null, runtimeMs: 0, outputBytes: null, budget: initialBudget, errorCode: "NOT_EXECUTED" },
      },
    ],
  };
}

async function executeCase(
  entry: ReturnType<typeof buildCase>,
  outputDirectory: string,
  budgets: BenchmarkBudgets,
  parentSignal?: AbortSignal
): Promise<ReturnType<typeof buildCase>> {
  const { asset, row } = entry;
  const caseDirectory = join(outputDirectory, "cases", asset.asset.assetId);
  const workspaceRoot = join(caseDirectory, "_workspace");
  await mkdir(caseDirectory, { recursive: true });
  const caseController = new AbortController();
  let timedOut = false;
  const startedAt = performance.now();
  const abortParent = (): void => caseController.abort();
  parentSignal?.addEventListener("abort", abortParent, { once: true });
  const budgetTimer = setTimeout(() => { timedOut = true; caseController.abort(); }, budgets.maxRuntimeMs);
  const initialBudget: CaseBudget = { runtimeMs: 0, outputBytes: 0, maxRuntimeMs: budgets.maxRuntimeMs,
    maxPages: budgets.maxPages, maxOutputBytes: budgets.maxOutputBytes, withinBudget: false };
  let execution: BenchmarkCase["execution"] = {
    pipelineExecution: "failed", disposition: null, pageCount: null, pageOrder: [], staffCounts: [], systemCounts: [],
    finalPageValidation: 0, artifactDirectory: `cases/${asset.asset.assetId}`, artifactSha256: null,
    runtimeMs: 0, outputBytes: null, budget: initialBudget, errorCode: "NOT_EXECUTED"
  };
  try {
    if (caseController.signal.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    const processor = new LocalVideoScoreProcessor({
      dataRoot: workspaceRoot,
      tools: { ffmpeg: defaultMediaTools.ffmpeg, ffprobe: defaultMediaTools.ffprobe },
      clock: () => new Date(0),
      reviewedPipelineFactory: asset.asset.assetId === "generated-16" ? () => createIndependentStructuredPipeline(asset) : undefined,
      frameArtifactSink: async (framePaths) => {
        const frameDirectory = join(caseDirectory, "frames");
        await mkdir(frameDirectory, { recursive: true });
        await Promise.all(framePaths.slice(0, 16).map(async (framePath, index) => {
          await sharp(framePath).png().toFile(join(frameDirectory, `page-${String(index + 1).padStart(4, "0")}.png`));
        }));
      }
    });
    const context = Object.assign((_progress: number) => undefined, {
      onProgress: (_progress: number) => undefined,
      signal: caseController.signal
    });
    const result = await processor.process({ videoPath: asset.sourcePath, videoId: asset.asset.assetId, durationMs: asset.asset.source.durationMs } satisfies LocalVideoJobInput, context);
    await cp(result.filePath, join(caseDirectory, "pipeline.pdf"));
    const pdfBytes = await readFile(result.filePath);
    const pdf = await PDFDocument.load(pdfBytes, { updateMetadata: false });
    const pageCount = pdf.getPageCount();
    const pageOrder = Array.from({ length: pageCount }, (_unused, index) => index + 1);
    if (pageCount > budgets.maxPages) throw new BenchmarkCaseError("PAGE_BUDGET_EXCEEDED");
    const pageFacts = await Promise.all(Array.from({ length: pageCount }, (_unused, index) =>
      inspectRasterArtifact(join(caseDirectory, "frames", `page-${String(index + 1).padStart(4, "0")}.png`))));
    const staffCounts = pageFacts.map((facts) => facts.staffCount);
    const systemCounts = pageFacts.map((facts) => facts.systemCount);
    const oracle = asset.labels.oracle;
    const finalPageValidation = oracle === undefined ? 0 : Number(
      oracle.expectedPageCount === pageCount
      && arraysEqual(oracle.expectedPageOrder, pageOrder)
      && arraysEqual(oracle.expectedStaffCounts, staffCounts)
      && arraysEqual(oracle.expectedSystemCounts, systemCounts)
    );
    execution = {
      pipelineExecution: "completed", disposition: result.reviewOutcome ?? "raster-fallback", pageCount, pageOrder,
      staffCounts, systemCounts, finalPageValidation, artifactDirectory: `cases/${asset.asset.assetId}`,
      artifactSha256: sha256(pdfBytes), runtimeMs: 0, outputBytes: null, budget: initialBudget
    };
  } catch (error) {
    if (parentSignal?.aborted) throw error;
    if (error instanceof Error && "code" in error && Reflect.get(error, "code") === "NO_SCORE_FOUND") {
      const blockedBytes = Buffer.from(canonicalJson({ schemaVersion: "score-benchmark-blocked/1", assetId: asset.asset.assetId, reason: "NO_SCORE_FOUND" }));
      await writeFile(join(caseDirectory, "blocked.json"), blockedBytes);
      execution = {
        pipelineExecution: "completed", disposition: "blocked", pageCount: 0, pageOrder: [], staffCounts: [], systemCounts: [],
        finalPageValidation: asset.labels.oracle?.expectedDisposition === "blocked" ? 1 : 0,
        artifactDirectory: `cases/${asset.asset.assetId}`, artifactSha256: sha256(blockedBytes), runtimeMs: 0, outputBytes: null, budget: initialBudget
      };
    } else {
    execution = {
      ...execution,
      pipelineExecution: "failed",
      errorCode: timedOut ? "RUNTIME_BUDGET_EXCEEDED"
        : error instanceof BenchmarkCaseError ? error.code
          : error instanceof Error && error.name === "AbortError" ? "CANCELLED"
            : error instanceof Error && "code" in error ? String(Reflect.get(error, "code")) : "PIPELINE_FAILED"
    };
    }
  } finally {
    clearTimeout(budgetTimer);
    parentSignal?.removeEventListener("abort", abortParent);
    await rm(workspaceRoot, { recursive: true, force: true });
  }
  const runtimeMs = measuredMs(startedAt, performance.now());
  const outputBytes = await directoryBytes(caseDirectory);
  const withinPipelineBudget = execution.pipelineExecution === "completed"
    && runtimeMs <= budgets.maxRuntimeMs && outputBytes <= budgets.maxOutputBytes
    && (execution.pageCount ?? 0) <= budgets.maxPages;
  if (execution.pipelineExecution === "completed" && !withinPipelineBudget) {
    execution = { ...execution, pipelineExecution: "failed", disposition: null, finalPageValidation: 0,
      errorCode: runtimeMs > budgets.maxRuntimeMs ? "RUNTIME_BUDGET_EXCEEDED"
        : outputBytes > budgets.maxOutputBytes ? "OUTPUT_BUDGET_EXCEEDED" : "PAGE_BUDGET_EXCEEDED" };
  }
  const budget: CaseBudget = { runtimeMs, outputBytes, maxRuntimeMs: budgets.maxRuntimeMs, maxPages: budgets.maxPages,
    maxOutputBytes: budgets.maxOutputBytes, withinBudget: withinPipelineBudget };
  execution = { ...execution, runtimeMs, outputBytes, budget };
  const executionBytes = Buffer.from(canonicalJson({ schemaVersion: "score-benchmark-execution/1", assetId: asset.asset.assetId, execution }));
  await writeFile(join(caseDirectory, "execution.json"), executionBytes);
  const artifactSha256 = execution.pipelineExecution === "completed" && execution.artifactSha256 !== null ? execution.artifactSha256 : sha256(executionBytes);
  const artifact = {
    relativePath: execution.pipelineExecution === "completed"
      ? execution.disposition === "blocked" ? `cases/${asset.asset.assetId}/blocked.json` : `cases/${asset.asset.assetId}/pipeline.pdf`
      : `cases/${asset.asset.assetId}/execution.json`,
    sha256: artifactSha256,
    pageCount: execution.pageCount
  };
  const evidence = entry.evidence.map((record) => ({
    ...record,
    pipelineExecution: execution.pipelineExecution,
    artifact,
    execution: { disposition: execution.disposition, runtimeMs: execution.runtimeMs, outputBytes: execution.outputBytes,
      budget: execution.budget, ...(execution.errorCode === undefined ? {} : { errorCode: execution.errorCode }) }
  }));
  return {
    ...entry,
    row: { ...row, withinBudget: row.withinBudget && execution.budget.withinBudget,
      execution: { ...execution, artifactSha256 } },
    evidence
  };
}

function summarizeExecution(cases: readonly BenchmarkCase[], assets: readonly LoadedCorpusAsset[]) {
  const generated = assets.filter(({ asset }) => asset.split !== "smoke");
  const generatedById = new Map(generated.map(({ asset }) => [asset.assetId, asset]));
  let oracleMatches = true;
  let finalPageValidation = 1;
  let structuredPredicted = 0;
  let structuredCorrect = 0;
  let fallbackExpected = 0;
  let fallbackCorrect = 0;
  let falseHardBlocks = 0;
  const failedCaseIds: string[] = [];
  for (const entry of cases) {
    const oracle = generatedById.get(entry.assetId) === undefined ? undefined : assets.find(({ asset }) => asset.assetId === entry.assetId)?.labels.oracle;
    const expected = oracle?.expectedDisposition;
    if (entry.execution.pipelineExecution !== "completed") {
      oracleMatches = false;
      failedCaseIds.push(entry.assetId);
    }
    if (expected !== undefined) {
      if (entry.execution.disposition !== expected
        || entry.execution.pageCount !== oracle?.expectedPageCount
        || !arraysEqual(entry.execution.pageOrder, oracle?.expectedPageOrder ?? [])
        || !arraysEqual(entry.execution.staffCounts, oracle?.expectedStaffCounts ?? [])
        || !arraysEqual(entry.execution.systemCounts, oracle?.expectedSystemCounts ?? [])) oracleMatches = false;
      finalPageValidation *= entry.execution.finalPageValidation;
      if (entry.execution.disposition === "structured") {
        structuredPredicted += 1;
        if (expected === "structured") structuredCorrect += 1;
      }
      if (expected === "raster-fallback") {
        fallbackExpected += 1;
        if (entry.execution.disposition === "raster-fallback") fallbackCorrect += 1;
      }
      if (entry.execution.disposition === "blocked" && expected !== "blocked") falseHardBlocks += 1;
    }
  }
  const contentOwners = new Map<string, string>();
  let sourceGroupsIsolated = true;
  for (const { asset, verifiedHashes } of assets) {
    const owner = contentOwners.get(verifiedHashes.contentSha256);
    if (owner !== undefined && owner !== asset.sourceGroupId) sourceGroupsIsolated = false;
    contentOwners.set(verifiedHashes.contentSha256, asset.sourceGroupId);
  }
  return {
    rightsAndHashesValid: assets.every(({ asset, verifiedHashes }) => asset.rights.decision === "approved"
      && verifiedHashes.sourceSha256.length === 64 && verifiedHashes.rightsEvidenceSha256.length === 64 && verifiedHashes.contentSha256.length === 64),
    sourceGroupsIsolated,
    allCasesExecuted: cases.every((entry) => entry.execution.pipelineExecution === "completed"),
    artifactsComplete: cases.every((entry) => entry.execution.pipelineExecution === "completed"
      && entry.execution.artifactSha256 !== null && entry.execution.artifactSha256.length === 64),
    failedCaseIds,
    oracleMatches,
    structuredPrecision: computeStructuredPrecision(structuredCorrect, structuredPredicted),
    fallbackRecall: fallbackExpected === 0 ? 1 : fallbackCorrect / fallbackExpected,
    falseHardBlocks,
    finalPageValidation,
  };
}

function arraysEqual(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function inspectRasterArtifact(path: string): Promise<Readonly<{ staffCount: number; systemCount: number }>> {
  const raw = await sharp(path).greyscale().raw().toBuffer({ resolveWithObject: true });
  const lineRows: number[] = [];
  let lineStart: number | null = null;
  const flushLine = (end: number): void => {
    if (lineStart !== null) {
      lineRows.push(Math.round((lineStart + end - 1) / 2));
      lineStart = null;
    }
  };
  for (let y = 1; y < raw.info.height - 1; y += 1) {
    let longestRun = 0;
    let run = 0;
    for (let x = 1; x < raw.info.width - 1; x += 1) {
      if ((raw.data[y * raw.info.width + x] ?? 255) < 230) {
        run += 1;
        longestRun = Math.max(longestRun, run);
      } else run = 0;
    }
    const isStaffLine = longestRun >= raw.info.width * 0.15 && longestRun < raw.info.width * 0.8;
    if (isStaffLine) lineStart ??= y;
    else flushLine(y);
  }
  flushLine(raw.info.height - 1);
  const staves: Array<Readonly<{ top: number; bottom: number; gap: number }>> = [];
  for (let index = 0; index + 4 < lineRows.length;) {
    const group = lineRows.slice(index, index + 5);
    const gaps = group.slice(0, 4).map((row, gapIndex) => (group[gapIndex + 1] ?? row) - row);
    const minimum = Math.min(...gaps);
    const maximum = Math.max(...gaps);
    if (minimum >= 2 && maximum <= minimum * 1.3) {
      const top = group[0];
      const bottom = group[4];
      if (top !== undefined && bottom !== undefined) staves.push({ top, bottom, gap: gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length });
      index += 5;
    } else index += 1;
  }
  if (staves.length === 0) return { staffCount: 0, systemCount: 0 };
  let systemCount = 1;
  for (let index = 1; index < staves.length; index += 1) {
    const previous = staves[index - 1];
    const current = staves[index];
    if (previous !== undefined && current !== undefined && current.top - previous.bottom > Math.max(previous.gap, current.gap) * 8) systemCount += 1;
  }
  return { staffCount: staves.length, systemCount };
}

async function directoryBytes(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(path);
    else if (entry.isFile()) total += (await lstat(path)).size;
  }
  return total;
}

function measuredMs(startedAt: number, finishedAt: number): number {
  return Math.max(0.001, finishedAt - startedAt);
}

async function createIndependentStructuredPipeline(asset: LoadedCorpusAsset): Promise<ReviewedPipeline | undefined> {
  if (asset.musicXmlPath === undefined) return undefined;
  const musicXml = await readFile(asset.musicXmlPath);
  const mxl = zipSync({
    "META-INF/container.xml": Buffer.from("<?xml version=\"1.0\"?><container><rootfiles><rootfile full-path=\"score.musicxml\" media-type=\"application/vnd.recordare.musicxml+xml\"/></rootfiles></container>"),
    "score.musicxml": musicXml
  }, { level: 6, mtime: new Date("1980-01-01T00:00:00.000Z") });
  return {
    stages: {
      reviewRaster: async ({ pages }: { readonly pages: readonly { readonly lineage: { readonly pageNumber: number } }[] }) => ({
        status: "pass" as const,
        omrEligible: true,
        findings: [],
        pages: pages.map((page) => ({ pageNumber: page.lineage.pageNumber, edgeBandPx: 0, boundaryInkRatio: 0, contamination: "clean" as const })),
        configDigest: RASTER_REVIEW_POLICY_DIGEST
      }),
      transcribe: async ({ pages }: { readonly pages: readonly AudiverisApprovedPage[] }) => ({
        kind: "structured" as const,
        pages: pages.map((page, index): AudiverisPageMxl => ({
          pageNumber: index + 1,
          lineage: page.lineage,
          inputSha256: sha256(musicXml),
          outputSha256: sha256(Buffer.from(mxl)),
          version: "5.11.0",
          durationMs: 0,
          exitCode: 0,
          logSummary: "independent MusicXML fixture",
          mxl
        }))
      }),
      render: async (request: { readonly outputPath: string; readonly pages: readonly MuseScorePageInput[] }) => {
        const document = await PDFDocument.create();
        for (const _page of request.pages) {
          const page = document.addPage([595.2755905511812, 841.8897637795276]);
          for (let line = 0; line < 5; line += 1) {
            const y = 700 - line * 10;
            page.drawLine({ start: { x: 80, y }, end: { x: 515, y }, thickness: 1 });
          }
        }
        const bytes = await document.save({ useObjectStreams: false });
        await writeFile(request.outputPath, bytes);
        return {
          ok: true as const,
          outputPath: request.outputPath,
          pages: request.pages.map((page) => ({ ...page, outputPageNumber: page.pageNumber, systemCount: page.sourceSystemCount,
            staffGroupCount: page.sourceStaffGroupCount, boundaryInk: false, pdfSha256: sha256(Buffer.from(bytes)) }))
        };
      }
    }
  };
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
  executionMetrics?: Readonly<Record<string, unknown>>;
  promotion: Readonly<{ eligible: boolean; promotionPassed: boolean; gateFailures: readonly string[] }> }>) {
  const { cases, runDigest, bootstrap, promotion, executionMetrics } = input;
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
    promotionPassed: promotion.promotionPassed, gateFailures: promotion.gateFailures,
    ...(executionMetrics === undefined ? {} : { execution: executionMetrics }) };
}

async function readModuleHashes(projectRoot: string): Promise<readonly { readonly relativePath: string; readonly sha256: string }[]> {
  const names = (await readdir(resolve(projectRoot, "benchmarks"))).filter((name) => name.endsWith(".ts"));
  const relativePaths = [...names.map((name) => `benchmarks/${name}`), "pipeline/youtube-score-processor.ts"].sort();
  return Promise.all(relativePaths.map(async (relativePath) => ({ relativePath, sha256: sha256(await readFile(resolve(projectRoot, relativePath))) })));
}

async function readToolVersions(projectRoot: string) {
  const { stdout } = await executeFile(defaultMediaTools.ffmpeg, ["-version"], { windowsHide: true, timeout: 15_000, maxBuffer: 2_000_000 });
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
async function findMissingArtifacts(directory: string): Promise<readonly string[]> {
  try {
    const lines = (await readFile(join(directory, "evidence.jsonl"), "utf8")).split(/\r?\n/u).filter(Boolean);
    const missing: string[] = [];
    for (const line of lines) {
      const record: unknown = JSON.parse(line);
      if (typeof record !== "object" || record === null) continue;
      const artifact = Reflect.get(record, "artifact");
      if (typeof artifact !== "object" || artifact === null) continue;
      const relativePath = Reflect.get(artifact, "relativePath");
      const expectedSha256 = Reflect.get(artifact, "sha256");
      if (typeof relativePath !== "string" || typeof expectedSha256 !== "string") continue;
      const path = resolve(directory, relativePath);
      const stats = await lstat(path).catch(() => null);
      if (stats === null || !stats.isFile() || sha256(await readFile(path)) !== expectedSha256) missing.push(relativePath);
    }
    return [...new Set(missing)].sort();
  } catch {
    return ["evidence.jsonl"];
  }
}
function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function compareFailures(left: { readonly assetId?: string; readonly code: string; readonly message: string }, right: { readonly assetId?: string; readonly code: string; readonly message: string }): number {
  return compareText(left.assetId ?? "", right.assetId ?? "") || compareText(left.code, right.code) || compareText(left.message, right.message);
}
