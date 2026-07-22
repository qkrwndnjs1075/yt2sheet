import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { computeScorePagePlacements, packScorePages } from "../src/shared/score-page-layout";
import { SCORE_IDENTITY_CONFIG } from "../src/shared/score-identity-config";
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

export async function createScorePdfFromFrames(
  framePaths: readonly string[],
  workspace: string,
  outputPath: string,
  onProgress: (progress: number) => void = () => undefined
): Promise<ScorePdfResult> {
  const scoreDirectory = join(workspace, "scores");
  const pageDirectory = join(workspace, "pages");
  await mkdir(scoreDirectory, { recursive: true });
  await mkdir(pageDirectory, { recursive: true });
  const scores: AcceptedScore[] = [];

  for (let index = 0; index < framePaths.length; index += 1) {
    const candidate = await analyzeFrame(framePaths[index], scoreDirectory, scores.length + 1);
    if (candidate && !scores.some((score) => isDuplicateScore(score, candidate))) {
      scores.push(candidate);
    } else if (candidate) {
      await rm(candidate.path, { force: true });
    }
    onProgress(45 + ((index + 1) / Math.max(1, framePaths.length)) * 30);
  }

  if (scores.length === 0) {
    throw new ScorePipelineError("NO_SCORE_FOUND", "영상에서 오선 또는 TAB 악보를 찾지 못했습니다.");
  }

  const pages = packScorePages(scores);
  const pagePaths: string[] = [];
  for (let index = 0; index < pages.length; index += 1) {
    const pagePath = join(pageDirectory, `page-${String(index + 1).padStart(4, "0")}.png`);
    await renderPage(pages[index], pagePath);
    pagePaths.push(pagePath);
  }
  onProgress(88);
  await writePdf(pagePaths, outputPath);
  onProgress(98);
  return { pageCount: pagePaths.length, scoreCount: scores.length };
}

export async function listExtractedFrames(frameDirectory: string): Promise<string[]> {
  const names = await readdir(frameDirectory);
  return names.filter((name) => /^frame-\d+\.(?:jpg|png)$/i.test(name)).sort().map((name) => join(frameDirectory, name));
}

async function analyzeFrame(framePath: string, outputDirectory: string, outputIndex: number): Promise<AcceptedScore | null> {
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
  const cropped = await image.clone().extract(roundCrop(sourceCrop, sourceMetadata.width, sourceMetadata.height)).png().toBuffer();
  const normalized = await normalizeScoreImage(cropped);
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

async function renderPage(scores: readonly AcceptedScore[], outputPath: string): Promise<void> {
  const { pageWidth, pageHeight } = SCORE_IDENTITY_CONFIG.page;
  const placements = computeScorePagePlacements(scores.map((score) => score.image));
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

async function writePdf(pagePaths: readonly string[], outputPath: string): Promise<void> {
  const pdf = await PDFDocument.create();
  const { pageWidth, pageHeight } = SCORE_IDENTITY_CONFIG.page;
  for (const pagePath of pagePaths) {
    const embedded = await pdf.embedPng(await readFile(pagePath));
    const page = pdf.addPage([pageWidth, pageHeight]);
    page.drawImage(embedded, { x: 0, y: 0, width: pageWidth, height: pageHeight });
  }
  await writeFile(outputPath, await pdf.save());
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
