import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { computeScorePagePlacements, packScorePages } from "../src/shared/score-page-layout";
import {
  SCORE_PDF_METADATA,
  STANDALONE_SCORE_PDF,
  type ScorePdfPageLayout,
  type ScorePdfContract
} from "../src/shared/score-identity-config";
import { buildPreprocessedFrame, findScoreCrop, hammingDistance, isNearDuplicate } from "./score-analysis";
import { createDifferenceHash, createDominantInkHash, normalizeScoreImage } from "./score-image-normalizer";
import { ScorePipelineError } from "./score-job-service";

type AcceptedScore = {
  readonly path: string;
  readonly hash: Uint8Array;
  readonly dominantHash: Uint8Array;
  readonly image: { readonly width: number; readonly height: number };
};

const ANALYSIS_WIDTH = 1_280;
const DOMINANT_DUPLICATE_DISTANCE = 8;

export type ScorePdfResult = {
  readonly pageCount: number;
  readonly scoreCount: number;
};

export type CreateScorePdfOptions = {
  readonly onProgress?: (progress: number) => void;
  readonly signal?: AbortSignal;
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
  const rasterLayout = rasterLayoutFor(STANDALONE_SCORE_PDF);
  const scoreDirectory = join(workspace, "scores");
  const pageDirectory = join(workspace, "pages");
  throwIfCancelled(options.signal);
  await mkdir(scoreDirectory, { recursive: true });
  throwIfCancelled(options.signal);
  await mkdir(pageDirectory, { recursive: true });
  throwIfCancelled(options.signal);
  const scores: AcceptedScore[] = [];

  for (let index = 0; index < framePaths.length; index += 1) {
    throwIfCancelled(options.signal);
    const candidate = await analyzeFrame(framePaths[index], scoreDirectory, scores.length + 1, rasterLayout);
    throwIfCancelled(options.signal);
    if (candidate && !scores.some((score) => isDuplicateScore(score, candidate))) {
      scores.push(candidate);
    } else if (candidate) {
      await rm(candidate.path, { force: true });
      throwIfCancelled(options.signal);
    }
    onProgress(45 + ((index + 1) / Math.max(1, framePaths.length)) * 30);
    throwIfCancelled(options.signal);
  }

  if (scores.length === 0) {
    throw new ScorePipelineError("NO_SCORE_FOUND", "영상에서 오선 또는 TAB 악보를 찾지 못했습니다.");
  }

  const pages = packScorePages(scores, rasterLayout);
  const pagePaths: string[] = [];
  for (let index = 0; index < pages.length; index += 1) {
    throwIfCancelled(options.signal);
    const pagePath = join(pageDirectory, `page-${String(index + 1).padStart(4, "0")}.png`);
    await renderPage(pages[index], pagePath, rasterLayout);
    throwIfCancelled(options.signal);
    pagePaths.push(pagePath);
  }
  onProgress(88);
  throwIfCancelled(options.signal);
  await writePdf(pagePaths, outputPath, STANDALONE_SCORE_PDF, options.metadata, options.signal);
  throwIfCancelled(options.signal);
  onProgress(98);
  throwIfCancelled(options.signal);
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
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 1) {
    throw new ScorePipelineError("IMAGE_DECODE_FAILED", "영상 프레임을 분석할 수 없습니다.");
  }
  const frame = buildPreprocessedFrame({ id: framePath, width: info.width, height: info.height, grayscale: data });
  const crop = findScoreCrop(frame);
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
  const hash = await createDifferenceHash(normalized);
  const dominantHash = await createDominantInkHash(normalized);
  const outputPath = join(outputDirectory, `score-${String(outputIndex).padStart(4, "0")}.png`);
  await writeFile(outputPath, normalized);
  return { path: outputPath, hash, dominantHash, image: { width: metadata.width, height: metadata.height } };
}

function isDuplicateScore(left: AcceptedScore, right: AcceptedScore): boolean {
  return isNearDuplicate(left.hash, right.hash)
    || hammingDistance(left.dominantHash, right.dominantHash) <= DOMINANT_DUPLICATE_DISTANCE;
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
