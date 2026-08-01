import sharp from "sharp";
import type { ScoreCrop } from "./score-analysis";

const OVERLAY_CHROMA_MIN = 24;
const MAX_COLORED_PIXEL_RATIO = 0.05;
const PAPER_CHANNEL_MIN = 205;
const PAPER_CHROMA_MAX = 12;
const PAPER_COLUMN_MIN_RATIO = 0.55;
const MAX_PAPER_GAP_RATIO = 0.05;
const MIN_PAPER_RUN_RATIO = 0.5;
const ANALYSIS_LIGHT_ARTIFACT_CHANNEL_MIN = 180;

type RawImageInfo = {
  readonly width: number;
  readonly height: number;
  readonly channels: 3;
};

type HorizontalBounds = {
  readonly left: number;
  readonly width: number;
};

export async function createGrayscaleAnalysis(data: Buffer, info: RawImageInfo): Promise<Buffer> {
  const canonical = Buffer.from(data);
  for (let index = 0; index < canonical.length; index += info.channels) {
    if (Math.min(canonical[index], canonical[index + 1], canonical[index + 2]) < ANALYSIS_LIGHT_ARTIFACT_CHANNEL_MIN) {
      continue;
    }
    canonical[index] = 255;
    canonical[index + 1] = 255;
    canonical[index + 2] = 255;
  }
  return sharp(canonical, { raw: info }).greyscale().raw().toBuffer();
}

export function prepareScoreCrop(data: Buffer, info: RawImageInfo, crop: ScoreCrop | null): ScoreCrop | null {
  if (crop === null) return null;
  const top = Math.max(0, Math.floor(crop.y));
  const bottom = Math.min(info.height, Math.ceil(crop.y + crop.height));
  const bounds = findHorizontalPaperBounds(data, info, crop, top, bottom);
  if (hasLargeColoredOverlay(data, info, bounds, top, bottom)) {
    return null;
  }
  return { ...crop, x: bounds.left, width: bounds.width };
}

function hasLargeColoredOverlay(
  data: Buffer,
  info: RawImageInfo,
  bounds: HorizontalBounds,
  top: number,
  bottom: number
): boolean {
  let coloredPixels = 0;
  const maximumColoredPixels = bounds.width * (bottom - top) * MAX_COLORED_PIXEL_RATIO;
  for (let y = top; y < bottom; y += 1) {
    for (let x = bounds.left; x < bounds.left + bounds.width; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      if (Math.max(red, green, blue) - Math.min(red, green, blue) <= OVERLAY_CHROMA_MIN) {
        continue;
      }
      coloredPixels += 1;
      if (coloredPixels > maximumColoredPixels) {
        return true;
      }
    }
  }
  return false;
}

function findHorizontalPaperBounds(
  data: Buffer,
  info: RawImageInfo,
  crop: ScoreCrop,
  top: number,
  bottom: number
): HorizontalBounds {
  const cropLeft = Math.max(0, Math.floor(crop.x));
  const cropRight = Math.min(info.width, Math.ceil(crop.x + crop.width));
  const cropWidth = cropRight - cropLeft;
  const minimumPaperPixels = Math.ceil((bottom - top) * PAPER_COLUMN_MIN_RATIO);
  const maximumPaperGap = Math.floor(cropWidth * MAX_PAPER_GAP_RATIO);
  let bestLeft = cropLeft;
  let bestWidth = 0;
  let runLeft = cropLeft;
  let lastPaper = -1;
  let paperGap = 0;
  let inRun = false;

  for (let x = cropLeft; x < cropRight; x += 1) {
    let paperPixels = 0;
    for (let y = top; y < bottom; y += 1) {
      if (isPaperPixel(data, (y * info.width + x) * info.channels)) {
        paperPixels += 1;
      }
    }
    const isPaperColumn = paperPixels >= minimumPaperPixels;
    if (isPaperColumn) {
      if (!inRun) {
        runLeft = x;
        inRun = true;
      }
      lastPaper = x;
      paperGap = 0;
      continue;
    }
    if (!inRun) continue;
    paperGap += 1;
    if (paperGap <= maximumPaperGap) continue;
    const runWidth = lastPaper - runLeft + 1;
    if (runWidth > bestWidth) {
      bestLeft = runLeft;
      bestWidth = runWidth;
    }
    inRun = false;
    lastPaper = -1;
    paperGap = 0;
  }
  if (inRun) {
    const runWidth = lastPaper - runLeft + 1;
    if (runWidth > bestWidth) {
      bestLeft = runLeft;
      bestWidth = runWidth;
    }
  }

  return bestWidth >= cropWidth * MIN_PAPER_RUN_RATIO
    ? { left: bestLeft, width: bestWidth }
    : { left: cropLeft, width: cropWidth };
}

function isPaperPixel(data: Buffer, offset: number): boolean {
  const red = data[offset];
  const green = data[offset + 1];
  const blue = data[offset + 2];
  return Math.min(red, green, blue) >= PAPER_CHANNEL_MIN
    && Math.max(red, green, blue) - Math.min(red, green, blue) <= PAPER_CHROMA_MAX;
}
