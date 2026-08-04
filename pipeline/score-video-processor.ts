import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { computeScorePagePlacements, packScorePages } from "./score-page-layout";
import {
  SCORE_PDF_METADATA,
  STANDALONE_SCORE_PDF,
  type ScorePdfPageLayout,
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

type AcceptedScore = {
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
const NOTATION_IDENTITY_CANDIDATE_DISTANCE = 34;
const MAX_NOTATION_IDENTITY_STAFF_GAP_DELTA = 0.08;
const MIN_REPRESENTATIVE_CONTENT_HEIGHT_GAIN_RATIO = 0.04;
const MIN_REPRESENTATIVE_READABILITY_GAIN = 8;
const DEFAULT_ANALYSIS_CONCURRENCY = 4;

export type ScorePdfResult = {
  readonly pageCount: number;
  readonly scoreCount: number;
};

export type CreateScorePdfOptions = {
  readonly onProgress?: (progress: number) => void;
  readonly signal?: AbortSignal;
  readonly concurrency?: number;
  readonly outputArtifactSink?: () => Promise<void>;
  readonly qualityReportSink?: (report: ScoreExtractionQualityReport) => Promise<void>;
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
  await writePdf(pagePaths, outputPath, STANDALONE_SCORE_PDF, options.metadata, options.signal);
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
      frames: createFrameDispositions(frameDecisions, scores, pages)
    }));
  }
  return { pageCount: pagePaths.length, scoreCount: scores.length };
}

export async function listExtractedFrames(frameDirectory: string): Promise<string[]> {
  const names = await readdir(frameDirectory);
  return names.filter((name) => /^frame-\d+\.(?:jpg|png)$/i.test(name)).sort().map((name) => join(frameDirectory, name));
}

async function analyzeFrame(
  framePath: string,
  outputDirectory: string,
  outputIndex: number,
  rasterLayout: ScorePdfPageLayout
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

function elapsedMs(startedAt: number, finishedAt: number): number {
  return Math.max(0, finishedAt - startedAt);
}

function hasSimilarStaffGap(left: number | null, right: number | null): boolean {
  if (left === null || right === null) return true;
  return Math.abs(left - right) / Math.max(left, right) <= MAX_NOTATION_IDENTITY_STAFF_GAP_DELTA;
}

async function renderPage(scores: readonly AcceptedScore[], outputPath: string, layout: ScorePdfPageLayout): Promise<void> {
  const { pageWidth, pageHeight } = layout;
  const placements = computeScorePagePlacements(scores.map((score) => score.image), layout);
  const composites = await Promise.all(scores.map(async (score, index) => {
    const placement = placements[index];
    const width = Math.max(1, Math.round(placement.width));
    const height = Math.max(1, Math.round(placement.height));
    const input = await sharp(await readFile(score.path)).resize(width, height, { fit: "fill" }).png().toBuffer();
    return { input, left: Math.round(placement.x), top: Math.round(placement.y) };
  }));
  await sharp({ create: { width: pageWidth, height: pageHeight, channels: 3, background: "white" } })
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
    const page = pdf.addPage([contract.pageWidth, contract.pageHeight]);
    page.drawImage(embedded, { x: 0, y: 0, width: contract.pageWidth, height: contract.pageHeight });
  }
  throwIfCancelled(signal);
  await writeFile(outputPath, await pdf.save());
  throwIfCancelled(signal);
}

function rasterLayoutFor(contract: ScorePdfContract): ScorePdfPageLayout {
  return {
    pageWidth: contract.rasterWidth,
    pageHeight: contract.rasterHeight,
    padding: contract.padding,
    gap: contract.gap
  };
}

function spacingScanBandFor(sourceWidth: number, layout: ScorePdfPageLayout): number {
  const contentWidth = Math.max(1, layout.pageWidth - layout.padding * 2);
  return sourceWidth * layout.gap / contentWidth;
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
