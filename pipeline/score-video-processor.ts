import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { z } from "zod";
import type { AudiverisApprovedPage, AudiverisPageMxl, AudiverisResult } from "./audiveris-adapter";
import type { MuseScorePageInput, MuseScoreRenderResult } from "./musescore-adapter";
import { MusicXmlValidationError, validateMxl } from "./musicxml-validator";
import { computeScorePagePlacements, packScorePages } from "./score-page-layout";
import {
  OMR_REVIEW_PAGE_LAYOUT,
  SCORE_PDF_METADATA,
  STANDALONE_SCORE_PDF,
  type ScoreRasterPageLayout,
  type ScorePdfContract
} from "./score-identity-config";
import { buildPreprocessedFrame, findScoreCrop, hammingDistance, isNearDuplicate } from "./score-analysis";
import {
  createDifferenceHash,
  createDeduplicationImage,
  createDominantInkHash,
  createNotationIdentity,
  createScoreRepresentativeQuality,
  hasFadedNotationOverlap,
  hasStrongNotationOverlap,
  normalizeScoreImage,
  type NotationIdentity,
  type ScoreRepresentativeQuality
} from "./score-image-normalizer";
import { createGrayscaleAnalysis, prepareScoreCrop } from "./score-image-preparer";
import { ScorePipelineError } from "./job-contract";
import { RASTER_REVIEW_POLICY_DIGEST, type RasterReviewResult } from "./score-raster-review";
import {
  createScoreReview,
  scoreReviewContract,
  type ScoreReview,
  type ScoreReviewDecision,
  type ScoreReviewDecisionInput
} from "./score-review-contract";
import {
  createScoreExtractionQualityReport,
  frameIdentifier,
  resolveDuplicateReason,
  scoreIdentifier,
  type DuplicateReason,
  type FrameDisposition,
  type FrameIdentifier,
  type ScoreExtractionQualityReport,
  type ScoreIdentifier
} from "./score-quality-report";
import { reviewStructuredScore } from "./structured-score-review";

type AcceptedScore = {
  readonly sourceFrameId: FrameIdentifier;
  readonly path: string;
  readonly hash: Uint8Array;
  readonly dominantHash: Uint8Array;
  readonly notationIdentity: NotationIdentity;
  readonly image: { readonly width: number; readonly height: number };
  readonly representativeQuality: ScoreRepresentativeQuality;
};

type FrameDecision =
  | { readonly frameId: FrameIdentifier; readonly disposition: "no-score" }
  | { readonly frameId: FrameIdentifier; readonly disposition: "accepted"; readonly scoreId: ScoreIdentifier; readonly scoreIndex: number }
  | { readonly frameId: FrameIdentifier; readonly disposition: "duplicate"; readonly duplicateReason: DuplicateReason };

type DuplicateMatch = {
  readonly scoreIndex: number;
  readonly reason: DuplicateReason;
};

const ANALYSIS_WIDTH = 1_280;
const DOMINANT_DUPLICATE_DISTANCE = 8;
const NOTATION_IDENTITY_CANDIDATE_DISTANCE = 40;
const MAX_NOTATION_IDENTITY_STAFF_GAP_DELTA = 0.08;
const MIN_REPRESENTATIVE_CONTENT_HEIGHT_GAIN_RATIO = 0.04;
const MIN_REPRESENTATIVE_READABILITY_GAIN = 8;
const DEFAULT_ANALYSIS_CONCURRENCY = 4;
const SHA256_HEX = /^[a-f0-9]{64}$/u;

const rasterReviewResultSchema = z.object({
  status: z.enum(["pass", "warning", "blocked"]),
  omrEligible: z.boolean(),
  findings: z.array(z.object({
    pageNumber: z.number().int().positive().nullable(),
    code: z.enum(["RASTER_LINEAGE_INVALID", "RASTER_CROP_CLIPPED", "RASTER_UNREADABLE", "RASTER_CONTAMINATED", "RASTER_LOW_CONTRAST", "RASTER_DUPLICATE_AMBIGUOUS"]),
    severity: z.enum(["hard", "warning"]),
    evidence: z.record(z.string(), z.number().finite())
  }).strict()),
  pages: z.array(z.object({
    pageNumber: z.number().int().positive(),
    edgeBandPx: z.number().finite().nonnegative(),
    boundaryInkRatio: z.number().finite().nonnegative().max(1),
    contamination: z.enum(["clean", "warning", "hard"])
  }).strict()),
  configDigest: z.string().regex(SHA256_HEX)
}).strict();

type FinalPdfCandidate = {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
};

type CheckedStructuredRender =
  | { readonly kind: "structured"; readonly render: Extract<MuseScoreRenderResult, { readonly ok: true }>; readonly candidate: FinalPdfCandidate }
  | { readonly kind: "raster-fallback"; readonly render: MuseScoreRenderResult };

export type ScorePdfResult = {
  readonly pageCount: number;
  readonly scoreCount: number;
  readonly filePath?: string;
  readonly reviewOutcome?: "structured" | "raster-fallback";
  readonly warnings?: readonly ScoreReviewDecision[];
};

export type ReviewedScorePipelineStage =
  | "analysis"
  | "deduplication"
  | "raster-composition"
  | "raster-review"
  | "raster-gate"
  | "audiveris"
  | "mxl-validation"
  | "musescore"
  | "selection"
  | "final-validation"
  | "commit";

export type ReviewedRasterPage = AudiverisApprovedPage & {
  readonly sourceSystemCount: number;
  readonly sourceStaffGroupCount: number;
};

export type ReviewedScorePipelineStages = {
  readonly reviewRaster: (request: {
    readonly pages: readonly ReviewedRasterPage[];
    readonly signal?: AbortSignal;
  }) => Promise<RasterReviewResult>;
  readonly transcribe: (request: {
    readonly pages: readonly AudiverisApprovedPage[];
    readonly signal?: AbortSignal;
  }) => Promise<AudiverisResult>;
  readonly render: (request: {
    readonly pages: readonly MuseScorePageInput[];
    readonly outputPath: string;
    readonly signal?: AbortSignal;
  }) => Promise<MuseScoreRenderResult>;
  readonly onMxlValidated?: () => void;
  readonly onSelection?: () => void;
  readonly onFinalValidation?: () => void;
  readonly onCommit?: () => void;
};

export type ReviewedScoreInternalReport = {
  readonly selectedLane: "structured" | "raster";
  readonly pageLineage: readonly ReviewedRasterPage["lineage"][];
  readonly warnings: readonly ScoreReviewDecision[];
  readonly review: ScoreReview;
};

export type ReviewedScorePipelineResult = {
  readonly filePath: string;
  readonly pageCount: number;
  readonly reviewOutcome: "structured" | "raster-fallback";
  readonly warnings: readonly ScoreReviewDecision[];
};

export type ReviewedScorePipelineRequest = {
  readonly rasterPdfPath: string;
  readonly structuredPdfPath: string;
  readonly outputPath: string;
  readonly workspace: string;
  readonly pages: readonly ReviewedRasterPage[];
  readonly transcriptionPages?: readonly AudiverisApprovedPage[];
  readonly stages: ReviewedScorePipelineStages;
  readonly signal?: AbortSignal;
  readonly onStage?: (stage: ReviewedScorePipelineStage) => void;
  readonly reportSink?: (report: ReviewedScoreInternalReport) => Promise<void>;
};

export async function orchestrateReviewedScorePipeline(request: ReviewedScorePipelineRequest): Promise<ReviewedScorePipelineResult> {
  const mxlPaths: string[] = [];
  try {
    enterReviewedStage(request, "raster-review");
    const rasterReview = validateRasterReviewResult(
      await request.stages.reviewRaster({ pages: request.pages, signal: request.signal }),
      request.pages
    );
    throwIfCancelled(request.signal);
    await validateReviewedRasterBoundary(request);
    throwIfCancelled(request.signal);
    enterReviewedStage(request, "raster-gate");
    if (!rasterReview.omrEligible || rasterReview.status === "blocked") {
      throw new ScorePipelineError("RASTER_REVIEW_FAILED", "검토된 래스터 악보가 안전 기준을 통과하지 못했습니다.", {
        cause: rasterReview.findings
      });
    }

    let review: ScoreReview;
    let selectedPath: string;
    let structuredCandidate: FinalPdfCandidate | undefined;
    let selectionEntered = false;
    if (rasterReview.status === "warning") {
      review = rasterFallbackReview(request.pages.length, rasterReview.findings);
      selectedPath = request.rasterPdfPath;
    } else {
      enterReviewedStage(request, "audiveris");
      const transcription = await request.stages.transcribe({ pages: request.transcriptionPages ?? request.pages, signal: request.signal });
      throwIfCancelled(request.signal);
      if (transcription.kind === "raster-fallback") {
        review = rasterFallbackReview(request.pages.length, [transcription.warning]);
        selectedPath = request.rasterPdfPath;
      } else {
        enterReviewedStage(request, "mxl-validation");
        const persisted = await persistStructuredPages(request, transcription.pages, mxlPaths);
        request.stages.onMxlValidated?.();
        throwIfCancelled(request.signal);
        if (!persisted.ok) {
          review = rasterFallbackReview(request.pages.length, [persisted.warning]);
          selectedPath = request.rasterPdfPath;
        } else {
          enterReviewedStage(request, "musescore");
          if (!await prepareStructuredCandidate(request)) {
            review = rasterFallbackReview(request.pages.length, [{ pageNumber: null, code: "STRUCTURED_PDF_INVALID", evidence: { validationReason: "candidate-path" } }]);
            selectedPath = request.rasterPdfPath;
          } else {
            const rendered = await request.stages.render({ pages: persisted.pages, outputPath: request.structuredPdfPath, signal: request.signal });
            throwIfCancelled(request.signal);
            enterReviewedStage(request, "selection");
            selectionEntered = true;
            const checkedRender = await checkStructuredRender(request, persisted.pages, rendered);
            const selection = reviewStructuredScore({ pageCount: request.pages.length, rasterPdfPath: request.rasterPdfPath, render: checkedRender.render });
            request.stages.onSelection?.();
            review = selection.review;
            selectedPath = selection.selectedPdfPath;
            if (checkedRender.kind === "structured" && selection.review.disposition === "structured") {
              structuredCandidate = checkedRender.candidate;
            }
          }
        }
      }
    }

    if (!selectionEntered) {
      enterReviewedStage(request, "selection");
      request.stages.onSelection?.();
    }
    const warnings = review.decisions.filter((decision) => scoreReviewContract(decision.code).severity === "warning");
    enterReviewedStage(request, "final-validation");
    const selectedCandidate = structuredCandidate ?? await finalPdfCandidate(selectedPath, request.pages.length);
    if (selectedCandidate === null) throw new ScorePipelineError("FINAL_PDF_INVALID", "최종 PDF를 확인할 수 없습니다.");
    request.stages.onFinalValidation?.();
    throwIfCancelled(request.signal);
    const selectedLane = review.selectedLane;
    if (selectedLane === null) throw new ScorePipelineError("FINAL_PDF_INVALID", "최종 PDF 선택 결과를 확인할 수 없습니다.");
    await request.reportSink?.({ selectedLane, pageLineage: request.pages.map((page) => page.lineage), warnings, review });
    throwIfCancelled(request.signal);
    enterReviewedStage(request, "commit");
    request.stages.onCommit?.();
    throwIfCancelled(request.signal);
    await mkdir(dirname(request.outputPath), { recursive: true });
    if (digestBytes(selectedCandidate.bytes) !== selectedCandidate.sha256) {
      throw new ScorePipelineError("FINAL_PDF_INVALID", "최종 PDF를 확인할 수 없습니다.");
    }
    await writeFile(request.outputPath, selectedCandidate.bytes, { flag: "wx" });
    return {
      filePath: request.outputPath,
      pageCount: request.pages.length,
      reviewOutcome: review.disposition === "structured" ? "structured" : "raster-fallback",
      warnings
    };
  } finally {
    await Promise.all(mxlPaths.map((path) => rm(path, { force: true })));
  }
}

async function persistStructuredPages(
  request: ReviewedScorePipelineRequest,
  pages: readonly AudiverisPageMxl[],
  mxlPaths: string[]
): Promise<
  | { readonly ok: true; readonly pages: readonly MuseScorePageInput[] }
  | { readonly ok: false; readonly warning: ScoreReviewDecisionInput }
> {
  if (pages.length !== request.pages.length) {
    return { ok: false, warning: lineageMismatch(null, request.pages.length, pages.length) };
  }
  const renderedPages: MuseScorePageInput[] = [];
  for (let index = 0; index < pages.length; index += 1) {
    throwIfCancelled(request.signal);
    const page = pages[index];
    const source = request.pages[index];
    const expectedPageNumber = index + 1;
    if (page === undefined || source === undefined || page.pageNumber !== expectedPageNumber
      || page.lineage.pageNumber !== expectedPageNumber
      || !sameLineage(page.lineage.sourceFrameIds, source.lineage.sourceFrameIds)
      || !sameLineage(page.lineage.sourceScoreIds, source.lineage.sourceScoreIds)) {
      return { ok: false, warning: lineageMismatch(page?.pageNumber ?? null, expectedPageNumber, page?.pageNumber ?? 0) };
    }
    try {
      await validateMxl(page.mxl);
    } catch (error) {
      if (error instanceof MusicXmlValidationError) {
        return {
          ok: false,
          warning: error.code === "MXL_UNSAFE"
            ? { pageNumber: page.pageNumber, code: "MXL_UNSAFE", evidence: { reason: error.reason } }
            : { pageNumber: page.pageNumber, code: "MUSICXML_INVALID", evidence: { validationReason: error.reason } }
        };
      }
      throw error;
    }
    const mxlPath = join(request.workspace, `review-page-${String(page.pageNumber).padStart(4, "0")}.mxl`);
    await writeFile(mxlPath, page.mxl, { flag: "wx" });
    mxlPaths.push(mxlPath);
    renderedPages.push({
      pageNumber: page.pageNumber,
      mxlPath,
      sourceSystemCount: source.sourceSystemCount,
      sourceStaffGroupCount: source.sourceStaffGroupCount
    });
  }
  return { ok: true, pages: renderedPages };
}

function rasterFallbackReview(
  pageCount: number,
  decisions: readonly ScoreReviewDecisionInput[]
): ScoreReview {
  return createScoreReview({
    disposition: "raster-fallback",
    rasterSafe: true,
    decisions: [...decisions, { pageNumber: null, code: "RASTER_FALLBACK_SELECTED", evidence: { pageCount } }]
  });
}

function lineageMismatch(pageNumber: number | null, expectedPageNumber: number, actualPageNumber: number): ScoreReviewDecisionInput {
  return { pageNumber, code: "STRUCTURED_LINEAGE_MISMATCH", evidence: { expectedPageNumber, actualPageNumber } };
}

function sameLineage(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateRasterReviewResult(value: unknown, pages: readonly ReviewedRasterPage[]): RasterReviewResult {
  const parsed = rasterReviewResultSchema.safeParse(value);
  if (!parsed.success) throw rasterReviewFailure();
  const review = parsed.data;
  const findingsMatchContract = review.findings.every((finding) => {
    const contract = scoreReviewContract(finding.code);
    const actualFields = Object.keys(finding.evidence).sort();
    const expectedFields = [...contract.evidenceFields].sort();
    return contract.severity === finding.severity
      && actualFields.length === expectedFields.length
      && actualFields.every((field, index) => field === expectedFields[index]);
  });
  const pagesMatchInput = review.pages.length === pages.length && review.pages.every((page, index) => page.pageNumber === index + 1);
  const hasHardFinding = review.findings.some((finding) => finding.severity === "hard");
  const hasWarningSignal = review.findings.length > 0 || review.pages.some((page) => page.contamination === "warning");
  const hasHardPage = review.pages.some((page) => page.contamination === "hard");
  const statusMatches = review.status === "pass"
    ? review.omrEligible && review.findings.length === 0 && !hasWarningSignal
    : review.status === "warning"
      ? review.omrEligible && !hasHardFinding && hasWarningSignal && !hasHardPage
      : !review.omrEligible && hasHardFinding;
  if (!findingsMatchContract || !pagesMatchInput || review.configDigest !== RASTER_REVIEW_POLICY_DIGEST || hasHardFinding || hasHardPage || !statusMatches) throw rasterReviewFailure();
  return review;
}

function rasterReviewFailure(): ScorePipelineError {
  return new ScorePipelineError("RASTER_REVIEW_FAILED", "검토된 래스터 악보가 안전 기준을 통과하지 못했습니다.");
}

async function validateReviewedRasterBoundary(request: ReviewedScorePipelineRequest): Promise<void> {
  const rasterPath = resolve(request.rasterPdfPath);
  if (rasterPath === resolve(request.structuredPdfPath) || rasterPath === resolve(request.outputPath)) throw rasterReviewFailure();
  if (await finalPdfCandidate(rasterPath, request.pages.length) === null) throw rasterReviewFailure();
  const frameIds = new Set<string>();
  const scoreIds = new Set<string>();
  let previousFrameId: string | undefined;
  let previousScoreId: string | undefined;
  for (let index = 0; index < request.pages.length; index += 1) {
    const page = request.pages[index];
    if (page === undefined || page.lineage.pageNumber !== index + 1 || page.lineage.sourceFrameIds.length === 0 || page.lineage.sourceScoreIds.length === 0) throw rasterReviewFailure();
    if (!await isNonEmptyRegularFile(page.path)) throw rasterReviewFailure();
    for (const frameId of page.lineage.sourceFrameIds) {
      if (!isOrderedLineageId(frameId, previousFrameId) || frameIds.has(frameId)) throw rasterReviewFailure();
      frameIds.add(frameId);
      previousFrameId = frameId;
    }
    for (const scoreId of page.lineage.sourceScoreIds) {
      if (!isOrderedLineageId(scoreId, previousScoreId) || scoreIds.has(scoreId)) throw rasterReviewFailure();
      scoreIds.add(scoreId);
      previousScoreId = scoreId;
    }
  }
}

function isOrderedLineageId(value: string, previous: string | undefined): boolean {
  return value.length > 0 && (previous === undefined || value > previous);
}

async function isNonEmptyRegularFile(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isFile() && !stats.isSymbolicLink() && stats.size > 0;
  } catch (error) {
    if (error instanceof Error && "code" in error) return false;
    throw error;
  }
}

async function prepareStructuredCandidate(request: ReviewedScorePipelineRequest): Promise<boolean> {
  const structuredPath = resolve(request.structuredPdfPath);
  if (structuredPath === resolve(request.rasterPdfPath) || structuredPath === resolve(request.outputPath)) return false;
  await rm(structuredPath, { force: true });
  return true;
}

async function checkStructuredRender(
  request: ReviewedScorePipelineRequest,
  expectedPages: readonly MuseScorePageInput[],
  render: MuseScoreRenderResult
): Promise<CheckedStructuredRender> {
  if (!render.ok) return { kind: "raster-fallback", render };
  const expectedOutputPath = resolve(request.structuredPdfPath);
  if (resolve(render.outputPath) !== expectedOutputPath || !renderedPagesMatch(expectedPages, render.pages)) {
    return { kind: "raster-fallback", render: structuredCandidateFailure("renderer-boundary") };
  }
  const candidate = await finalPdfCandidate(expectedOutputPath, expectedPages.length);
  if (candidate === null) return { kind: "raster-fallback", render: structuredCandidateFailure("candidate-bytes") };
  return { kind: "structured", render, candidate };
}

function renderedPagesMatch(
  expectedPages: readonly MuseScorePageInput[],
  renderedPages: Extract<MuseScoreRenderResult, { readonly ok: true }>["pages"]
): boolean {
  return renderedPages.length === expectedPages.length && renderedPages.every((page, index) => {
    const expected = expectedPages[index];
    return expected !== undefined
      && page.pageNumber === expected.pageNumber
      && page.mxlPath === expected.mxlPath
      && page.sourceSystemCount === expected.sourceSystemCount
      && page.sourceStaffGroupCount === expected.sourceStaffGroupCount
      && SHA256_HEX.test(page.pdfSha256);
  });
}

function structuredCandidateFailure(validationReason: string): MuseScoreRenderResult {
  return { ok: false, failures: [{ pageNumber: null, code: "STRUCTURED_PDF_INVALID", evidence: { validationReason } }] };
}

function enterReviewedStage(request: ReviewedScorePipelineRequest, stage: ReviewedScorePipelineStage): void {
  request.onStage?.(stage);
  throwIfCancelled(request.signal);
}

function enterCreationStage(options: CreateScorePdfOptions, stage: ReviewedScorePipelineStage): void {
  options.reviewedPipeline?.onStage?.(stage);
  throwIfCancelled(options.signal);
}

async function finalPdfCandidate(path: string, expectedPageCount: number): Promise<FinalPdfCandidate | null> {
  try {
    if (!await isNonEmptyRegularFile(path)) return null;
    const bytes = await readFile(path);
    const document = await PDFDocument.load(bytes, { updateMetadata: false });
    if (document.getPageCount() !== expectedPageCount) throw new TypeError("page-count");
    for (const page of document.getPages()) {
      if (Math.abs(page.getWidth() - STANDALONE_SCORE_PDF.pdfPageWidthPoints) > 0.02
        || Math.abs(page.getHeight() - STANDALONE_SCORE_PDF.pdfPageHeightPoints) > 0.02) {
        throw new TypeError("page-box");
      }
    }
    return { path, bytes, sha256: digestBytes(bytes) };
  } catch (error) {
    if (error instanceof Error) return null;
    throw error;
  }
}

function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type CreateScorePdfOptions = {
  readonly onProgress?: (progress: number) => void;
  readonly signal?: AbortSignal;
  readonly concurrency?: number;
  readonly outputArtifactSink?: () => Promise<void>;
  readonly qualityReportSink?: (report: ScoreExtractionQualityReport) => Promise<void>;
  readonly reviewedPipeline?: {
    readonly stages: ReviewedScorePipelineStages;
    readonly reportSink?: (report: ReviewedScoreInternalReport) => Promise<void>;
    readonly onStage?: (stage: ReviewedScorePipelineStage) => void;
  };
  readonly nowMs?: () => number;
  readonly metadata: {
    readonly videoId: string;
    readonly createdAt: Date;
  };
};

export async function createScorePdfFromFrames(
  framePaths: readonly string[],
  workspace: string,
  outputPath: string,
  options: CreateScorePdfOptions
): Promise<ScorePdfResult> {
  const onProgress = options.onProgress ?? (() => undefined);
  const nowMs = options.nowMs ?? (() => performance.now());
  const totalStartedAt = nowMs();
  const rasterLayout = rasterLayoutFor(STANDALONE_SCORE_PDF);
  const scoreDirectory = join(workspace, "scores");
  const pageDirectory = join(workspace, "pages");
  throwIfCancelled(options.signal);
  await mkdir(scoreDirectory, { recursive: true });
  throwIfCancelled(options.signal);
  await mkdir(pageDirectory, { recursive: true });
  throwIfCancelled(options.signal);
  // Phase 1: 병렬 프레임 분석 (순서 보존, 중복 제거는 Phase 2에서)
  enterCreationStage(options, "analysis");
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_ANALYSIS_CONCURRENCY);
  let completedFrames = 0;
  const analysisStartedAt = nowMs();
  const candidates = await mapWithConcurrency(
    framePaths,
    concurrency,
    async (framePath, index) => {
      throwIfCancelled(options.signal);
      const candidate = await analyzeFrame(framePath, scoreDirectory, index + 1, rasterLayout);
      completedFrames += 1;
      onProgress(45 + (completedFrames / Math.max(1, framePaths.length)) * 30);
      return candidate;
    }
  );
  const analysisFinishedAt = nowMs();

  // Phase 2: 순차 중복 제거 (해시 비교만 수행 — 저렴)
  enterCreationStage(options, "deduplication");
  const scores: AcceptedScore[] = [];
  const frameDecisions: FrameDecision[] = [];
  const deduplicationStartedAt = nowMs();
  for (let index = 0; index < candidates.length; index += 1) {
    throwIfCancelled(options.signal);
    const candidate = candidates[index];
    const frameId = frameIdentifier(index + 1);
    if (candidate === null) {
      frameDecisions.push({ frameId, disposition: "no-score" });
      continue;
    }
    const duplicateMatch = findDuplicateMatch(scores, candidate);
    if (duplicateMatch === null) {
      scores.push(candidate);
      frameDecisions.push({ frameId, disposition: "accepted", scoreId: scoreIdentifier(scores.length), scoreIndex: scores.length - 1 });
    } else {
      const retained = scores[duplicateMatch.scoreIndex];
      const discarded = shouldReplaceRepresentative(retained, candidate) ? retained : candidate;
      if (discarded === retained) scores[duplicateMatch.scoreIndex] = candidate;
      frameDecisions.push({ frameId, disposition: "duplicate", duplicateReason: duplicateMatch.reason });
      await rm(discarded.path, { force: true });
    }
  }
  const deduplicationFinishedAt = nowMs();

  if (scores.length === 0) {
    throw new ScorePipelineError("NO_SCORE_FOUND", "영상에서 오선 또는 TAB 악보를 찾지 못했습니다.");
  }

  // Phase 3: 병렬 페이지 렌더링
  enterCreationStage(options, "raster-composition");
  const pageCompositionStartedAt = nowMs();
  const pages = packScorePages(scores, rasterLayout);
  const pagePaths = await Promise.all(pages.map(async (page, index) => {
    throwIfCancelled(options.signal);
    const pagePath = join(pageDirectory, `page-${String(index + 1).padStart(4, "0")}.png`);
    await renderPage(page, pagePath, rasterLayout);
    return pagePath;
  }));
  onProgress(88);
  throwIfCancelled(options.signal);
  let reviewedResult: ReviewedScorePipelineResult | undefined;
  let reviewedReport: ReviewedScoreInternalReport | undefined;
  if (options.reviewedPipeline === undefined) {
    await writePdf(pagePaths, outputPath, STANDALONE_SCORE_PDF, options.metadata, options.signal);
  } else {
    const rasterPdfPath = join(workspace, "reviewed-raster.pdf");
    const structuredPdfPath = join(workspace, "reviewed-structured.pdf");
    const omrPageDirectory = join(workspace, "omr-pages");
    await writePdf(pagePaths, rasterPdfPath, STANDALONE_SCORE_PDF, options.metadata, options.signal);
    try {
      await mkdir(omrPageDirectory, { recursive: true });
      const omrPagePaths: string[] = [];
      for (let index = 0; index < pages.length; index += 1) {
        throwIfCancelled(options.signal);
        const pagePath = join(omrPageDirectory, `page-${String(index + 1).padStart(4, "0")}.png`);
        await renderPage(pages[index] ?? [], pagePath, OMR_REVIEW_PAGE_LAYOUT);
        omrPagePaths.push(pagePath);
      }
      throwIfCancelled(options.signal);
      const reviewedPages = await createReviewedRasterPages(pagePaths, pages, scores, frameDecisions);
      reviewedResult = await orchestrateReviewedScorePipeline({
        rasterPdfPath,
        structuredPdfPath,
        outputPath,
        workspace,
        pages: reviewedPages,
        transcriptionPages: reviewedPages.map((page, index) => ({
          path: omrPagePaths[index] ?? "",
          lineage: page.lineage
        })),
        stages: options.reviewedPipeline.stages,
        signal: options.signal,
        onStage: options.reviewedPipeline.onStage,
        reportSink: async (report) => {
          reviewedReport = report;
          await options.reviewedPipeline?.reportSink?.(report);
        }
      });
    } finally {
      await rm(omrPageDirectory, { recursive: true, force: true });
    }
  }
  await options.outputArtifactSink?.();
  const pageCompositionFinishedAt = nowMs();
  throwIfCancelled(options.signal);
  onProgress(98);
  throwIfCancelled(options.signal);
  const totalFinishedAt = nowMs();
  if (options.qualityReportSink) {
    await options.qualityReportSink(createScoreExtractionQualityReport({
      durationsMs: {
        analysis: elapsedMs(analysisStartedAt, analysisFinishedAt),
        deduplication: elapsedMs(deduplicationStartedAt, deduplicationFinishedAt),
        pageComposition: elapsedMs(pageCompositionStartedAt, pageCompositionFinishedAt),
        total: elapsedMs(totalStartedAt, totalFinishedAt)
      },
      frames: createFrameDispositions(frameDecisions, scores, pages),
      ...(reviewedReport === undefined ? {} : {
        review: {
          disposition: reviewedReport.review.disposition,
          rasterSafe: reviewedReport.review.disposition !== "blocked",
          decisions: reviewedReport.review.decisions
        }
      })
    }));
  }
  return reviewedResult === undefined
    ? { pageCount: pagePaths.length, scoreCount: scores.length }
    : { ...reviewedResult, scoreCount: scores.length };
}

export async function listExtractedFrames(frameDirectory: string): Promise<string[]> {
  const names = await readdir(frameDirectory);
  return names.filter((name) => /^frame-\d+\.(?:jpg|png)$/i.test(name)).sort().map((name) => join(frameDirectory, name));
}

async function analyzeFrame(
  framePath: string,
  outputDirectory: string,
  outputIndex: number,
  rasterLayout: ScoreRasterPageLayout
): Promise<AcceptedScore | null> {
  const image = sharp(framePath, { limitInputPixels: 40_000_000 });
  const sourceMetadata = await image.metadata();
  if (!sourceMetadata.width || !sourceMetadata.height) {
    return null;
  }
  const { data, info } = await image.clone()
    .resize({ width: ANALYSIS_WIDTH, withoutEnlargement: true })
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) {
    throw new ScorePipelineError("IMAGE_DECODE_FAILED", "영상 프레임을 분석할 수 없습니다.");
  }
  const rgbInfo = { width: info.width, height: info.height, channels: info.channels };
  const frame = buildPreprocessedFrame({ id: framePath, width: info.width, height: info.height, grayscale: await createGrayscaleAnalysis(data, rgbInfo) });
  const crop = prepareScoreCrop(data, rgbInfo, findScoreCrop(frame));
  if (!crop) {
    return null;
  }

  const scaleX = sourceMetadata.width / info.width;
  const scaleY = sourceMetadata.height / info.height;
  const sourceCrop = {
    x: crop.x * scaleX,
    y: crop.y * scaleY,
    width: crop.width * scaleX,
    height: crop.height * scaleY
  };
  const cropBounds = roundCrop(sourceCrop, sourceMetadata.width, sourceMetadata.height);
  const cropped = await image.clone().extract(cropBounds).png().toBuffer();
  const normalized = await normalizeScoreImage(cropped, spacingScanBandFor(cropBounds.width, rasterLayout));
  const metadata = await sharp(normalized).metadata();
  if (!metadata.width || !metadata.height) {
    return null;
  }
  const deduplicationImage = await createDeduplicationImage(normalized);
  const [hash, dominantHash, notationIdentity, representativeQuality] = await Promise.all([
    createDifferenceHash(normalized),
    createDominantInkHash(normalized),
    createNotationIdentity(deduplicationImage),
    createScoreRepresentativeQuality(normalized)
  ]);
  if (dominantHash === null) return null;
  const outputPath = join(outputDirectory, `score-${String(outputIndex).padStart(4, "0")}.png`);
  await writeFile(outputPath, normalized);
  return {
    sourceFrameId: frameIdentifier(outputIndex),
    path: outputPath,
    hash,
    dominantHash,
    notationIdentity,
    image: { width: metadata.width, height: metadata.height },
    representativeQuality
  };
}

function findDuplicateMatch(scores: readonly AcceptedScore[], candidate: AcceptedScore): DuplicateMatch | null {
  for (let scoreIndex = 0; scoreIndex < scores.length; scoreIndex += 1) {
    const score = scores[scoreIndex];
    const duplicateReason = duplicateReasonForPair(score, candidate);
    if (duplicateReason !== null) return { scoreIndex, reason: duplicateReason };
  }
  return null;
}

function shouldReplaceRepresentative(retained: AcceptedScore, candidate: AcceptedScore): boolean {
  const retainedContent = retained.representativeQuality.contentHeightRatio;
  const candidateContent = candidate.representativeQuality.contentHeightRatio;
  if (candidateContent >= retainedContent * (1 + MIN_REPRESENTATIVE_CONTENT_HEIGHT_GAIN_RATIO)) return true;
  if (retainedContent >= candidateContent * (1 + MIN_REPRESENTATIVE_CONTENT_HEIGHT_GAIN_RATIO)) return false;
  const retainedReadability = retained.representativeQuality.paperLuminance + retained.representativeQuality.inkContrast;
  const candidateReadability = candidate.representativeQuality.paperLuminance + candidate.representativeQuality.inkContrast;
  return candidateReadability >= retainedReadability + MIN_REPRESENTATIVE_READABILITY_GAIN;
}

function duplicateReasonForPair(left: AcceptedScore, right: AcceptedScore): DuplicateReason | null {
  const differenceDistance = hammingDistance(left.hash, right.hash);
  if (isNearDuplicate(left.hash, right.hash)) {
    return resolveDuplicateReason({ nearDuplicate: true, dominantInk: false, notationIdentity: false });
  }
  if (hammingDistance(left.dominantHash, right.dominantHash) <= DOMINANT_DUPLICATE_DISTANCE) {
    return resolveDuplicateReason({ nearDuplicate: false, dominantInk: true, notationIdentity: false });
  }
  if (differenceDistance <= NOTATION_IDENTITY_CANDIDATE_DISTANCE
    && hasSimilarStaffGap(left.notationIdentity.staffGap, right.notationIdentity.staffGap)
    && (hasStrongNotationOverlap(left.notationIdentity, right.notationIdentity)
      || hasFadedNotationOverlap(
        left.notationIdentity,
        right.notationIdentity,
        left.representativeQuality.paperLuminance,
        right.representativeQuality.paperLuminance
      ))) {
    return resolveDuplicateReason({ nearDuplicate: false, dominantInk: false, notationIdentity: true });
  }
  return null;
}

function createFrameDispositions(
  decisions: readonly FrameDecision[],
  scores: readonly AcceptedScore[],
  pages: readonly (readonly AcceptedScore[])[]
): readonly FrameDisposition[] {
  return decisions.map((decision) => {
    switch (decision.disposition) {
      case "no-score":
        return decision;
      case "duplicate":
        return decision;
      case "accepted":
        return {
          frameId: decision.frameId,
          disposition: "accepted",
          scoreId: decision.scoreId,
          pageNumber: pages.findIndex((page) => page.includes(scores[decision.scoreIndex])) + 1
        };
      default:
        return decision;
    }
  });
}

async function createReviewedRasterPages(
  pagePaths: readonly string[],
  pages: readonly (readonly AcceptedScore[])[],
  scores: readonly AcceptedScore[],
  decisions: readonly FrameDecision[]
): Promise<readonly ReviewedRasterPage[]> {
  return Promise.all(pages.map(async (page, pageIndex) => {
    const scoreIndexes = page.map((score) => scores.indexOf(score));
    const accepted = decisions.filter((decision): decision is Extract<FrameDecision, { readonly disposition: "accepted" }> =>
      decision.disposition === "accepted" && scoreIndexes.includes(decision.scoreIndex));
    const structure = await inspectRasterPageStructure(pagePaths[pageIndex] ?? "");
    return {
      path: pagePaths[pageIndex] ?? "",
      lineage: {
        pageNumber: pageIndex + 1,
        sourceFrameIds: page.map((score) => score.sourceFrameId),
        sourceScoreIds: accepted.map((decision) => decision.scoreId)
      },
      sourceSystemCount: structure.systemCount,
      sourceStaffGroupCount: structure.staffGroupCount
    };
  }));
}

async function inspectRasterPageStructure(path: string): Promise<{ readonly systemCount: number; readonly staffGroupCount: number }> {
  const raw = await sharp(path).greyscale().raw().toBuffer({ resolveWithObject: true });
  const staffRows: number[] = [];
  for (let y = 0; y < raw.info.height; y += 1) {
    let darkPixels = 0;
    for (let x = 0; x < raw.info.width; x += 1) {
      if (raw.data[y * raw.info.width + x] < 180) darkPixels += 1;
    }
    if (darkPixels >= raw.info.width * 0.35 && (staffRows.at(-1) ?? -2) < y - 1) staffRows.push(y);
  }
  const staves: Array<{ readonly top: number; readonly bottom: number; readonly gap: number }> = [];
  for (let index = 0; index + 4 < staffRows.length;) {
    const group = staffRows.slice(index, index + 5);
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
  if (staves.length === 0) return { systemCount: 1, staffGroupCount: 1 };
  let systemCount = 1;
  for (let index = 1; index < staves.length; index += 1) {
    const previous = staves[index - 1];
    const current = staves[index];
    if (previous !== undefined && current !== undefined && current.top - previous.bottom > Math.max(previous.gap, current.gap) * 8) systemCount += 1;
  }
  return { systemCount, staffGroupCount: staves.length };
}

function elapsedMs(startedAt: number, finishedAt: number): number {
  return Math.max(0, finishedAt - startedAt);
}

function hasSimilarStaffGap(left: number | null, right: number | null): boolean {
  if (left === null || right === null) return true;
  return Math.abs(left - right) / Math.max(left, right) <= MAX_NOTATION_IDENTITY_STAFF_GAP_DELTA;
}

async function renderPage(scores: readonly AcceptedScore[], outputPath: string, layout: ScoreRasterPageLayout): Promise<void> {
  const { rasterWidth, rasterHeight } = layout;
  const placements = computeScorePagePlacements(scores.map((score) => score.image), layout);
  const composites = await Promise.all(scores.map(async (score, index) => {
    const placement = placements[index];
    const width = Math.max(1, Math.round(placement.width));
    const height = Math.max(1, Math.round(placement.height));
    const input = await sharp(await readFile(score.path)).resize(width, height, { fit: "fill" }).png().toBuffer();
    return { input, left: Math.round(placement.x), top: Math.round(placement.y) };
  }));
  await sharp({ create: { width: rasterWidth, height: rasterHeight, channels: 3, background: "white" } })
    .composite(composites)
    .png()
    .toFile(outputPath);
}

async function writePdf(
  pagePaths: readonly string[],
  outputPath: string,
  contract: ScorePdfContract,
  metadata: CreateScorePdfOptions["metadata"],
  signal?: AbortSignal
): Promise<void> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`yt2sheet score - ${metadata.videoId}`);
  pdf.setSubject(SCORE_PDF_METADATA.subject);
  pdf.setKeywords([...SCORE_PDF_METADATA.keywords]);
  pdf.setCreator(SCORE_PDF_METADATA.creator);
  pdf.setProducer(SCORE_PDF_METADATA.producer);
  pdf.setCreationDate(metadata.createdAt);
  pdf.setModificationDate(metadata.createdAt);
  for (const pagePath of pagePaths) {
    throwIfCancelled(signal);
    const embedded = await pdf.embedPng(await readFile(pagePath));
    throwIfCancelled(signal);
    const page = pdf.addPage([contract.pdfPageWidthPoints, contract.pdfPageHeightPoints]);
    page.drawImage(embedded, { x: 0, y: 0, width: contract.pdfPageWidthPoints, height: contract.pdfPageHeightPoints });
  }
  throwIfCancelled(signal);
  await writeFile(outputPath, await pdf.save());
  throwIfCancelled(signal);
}

function rasterLayoutFor(contract: ScorePdfContract): ScoreRasterPageLayout {
  return {
    rasterWidth: contract.rasterWidth,
    rasterHeight: contract.rasterHeight,
    contentMarginPixels: contract.contentMarginPixels,
    interSheetGapPixels: contract.interSheetGapPixels
  };
}

function spacingScanBandFor(sourceWidth: number, layout: ScoreRasterPageLayout): number {
  const contentWidth = Math.max(1, layout.rasterWidth - layout.contentMarginPixels * 2);
  return sourceWidth * layout.interSheetGapPixels / contentWidth;
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await fn(items[index], index);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export function roundCrop(crop: { x: number; y: number; width: number; height: number }, width: number, height: number) {
  const left = Math.max(0, Math.floor(crop.x));
  const top = Math.max(0, Math.floor(crop.y));
  const bottom = Math.min(height, Math.floor(crop.y + crop.height));
  return {
    left,
    top,
    width: Math.max(1, Math.min(width - left, Math.ceil(crop.width))),
    height: Math.max(1, bottom - top)
  };
}
