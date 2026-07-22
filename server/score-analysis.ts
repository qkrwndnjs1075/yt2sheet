import type { Rect } from "../src/shared/layout-types";
import { StaffCandidateDetector } from "../src/offscreen/layout/staff-candidate-detector";
import type { PreprocessedFrame } from "../src/offscreen/layout/preprocessed-frame";

type RawGrayscaleFrame = {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly grayscale: Uint8Array;
};

type StaffBounds = {
  readonly top: number;
  readonly bottom: number;
  readonly gap: number;
};

const SIMPLE_THRESHOLD = 180;
const TOP_MARGIN_GAPS = 12;
const BOTTOM_MARGIN_GAPS = 2;
const MIN_CONTENT_RATIO = 0.002;
const NON_PAPER_BOUNDARY_ROWS = 8;

export function buildPreprocessedFrame(input: RawGrayscaleFrame): PreprocessedFrame {
  if (input.grayscale.length !== input.width * input.height) {
    throw new RangeError("Grayscale frame dimensions do not match its pixel data.");
  }

  const threshold = estimateThreshold(input.grayscale);
  const binary = new Uint8Array(input.grayscale.length);
  const rowDarkCounts = Array.from({ length: input.height }, () => 0);
  const rowLineScores = Array.from({ length: input.height }, () => 0);
  const rowEdgeScores = Array.from({ length: input.height }, () => 0);
  const rowBrightCounts = Array.from({ length: input.height }, () => 0);

  for (let y = 0; y < input.height; y += 1) {
    let longestRun = 0;
    let currentRun = 0;
    for (let x = 0; x < input.width; x += 1) {
      const index = y * input.width + x;
      const gray = input.grayscale[index];
      const dark = gray < threshold ? 1 : 0;
      binary[index] = dark;
      if (dark === 1) {
        rowDarkCounts[y] += 1;
        currentRun += 1;
        longestRun = Math.max(longestRun, currentRun);
      } else {
        currentRun = 0;
      }
      if (gray >= 205) {
        rowBrightCounts[y] += 1;
      }
      if (x > 0 && Math.abs(gray - input.grayscale[index - 1]) >= 34) {
        rowEdgeScores[y] += 1;
      }
    }
    rowLineScores[y] = Math.max(rowDarkCounts[y] / input.width, longestRun / input.width);
    rowEdgeScores[y] /= input.width;
  }

  return {
    frameId: input.id,
    width: input.width,
    height: input.height,
    originalWidth: input.width,
    originalHeight: input.height,
    sourceRect: { x: 0, y: 0, width: input.width, height: input.height },
    analysisScale: 1,
    binary,
    rowDarkCounts,
    rowLineScores,
    rowEdgeScores,
    rowBrightCounts,
    threshold
  };
}

export function findScoreCrop(frame: PreprocessedFrame): Rect | null {
  const detectedStaffs = new StaffCandidateDetector().find(frame, []).filter((staff) => isPaperBacked(frame, staff.rect));
  if (detectedStaffs.length === 0) {
    return null;
  }
  const regularStaffs = detectedStaffs.filter((staff) => staff.metrics.lineRegularity >= 0.5);
  const staffs = regularStaffs.length > 0 ? regularStaffs : detectedStaffs;

  const top = Math.min(...staffs.map((staff) => staff.rect.y));
  const bottom = Math.max(...staffs.map((staff) => staff.rect.y + staff.rect.height));
  const largestGap = Math.max(...staffs.map((staff) => staff.metrics.estimatedLineGap));
  const content = findConnectedContentBounds(frame, { top, bottom, gap: largestGap });
  const topMargin = Math.max(48, largestGap * TOP_MARGIN_GAPS);
  const bottomMargin = Math.max(16, largestGap * BOTTOM_MARGIN_GAPS);
  const topLimit = Math.min(top - topMargin, content.top - largestGap);
  const bottomLimit = Math.max(bottom + bottomMargin, content.bottom + largestGap);
  const y = findPaperEdge(frame, Math.floor(top), Math.max(0, Math.floor(topLimit)), -1);
  const cropBottom = findPaperEdge(frame, Math.ceil(bottom), Math.min(frame.originalHeight, Math.ceil(bottomLimit)), 1);
  return { x: 0, y, width: frame.originalWidth, height: Math.max(1, cropBottom - y) };
}

function findConnectedContentBounds(
  frame: PreprocessedFrame,
  staff: StaffBounds
): { readonly top: number; readonly bottom: number } {
  const bands: Array<{ readonly top: number; readonly bottom: number }> = [];
  let bandTop: number | null = null;
  for (let y = 0; y <= frame.height; y += 1) {
    const isContent = y < frame.height
      && frame.rowDarkCounts[y] / frame.width >= MIN_CONTENT_RATIO
      && frame.rowBrightCounts[y] / frame.width >= 0.55;
    if (isContent) {
      bandTop ??= y;
    } else if (bandTop !== null) {
      bands.push({ top: bandTop, bottom: y });
      bandTop = null;
    }
  }

  const firstSeed = bands.findIndex((band) => band.bottom >= staff.top - staff.gap && band.top <= staff.bottom + staff.gap);
  if (firstSeed < 0) {
    return { top: staff.top, bottom: staff.bottom };
  }
  let first = firstSeed;
  let last = firstSeed;
  while (last + 1 < bands.length && bands[last + 1].top <= staff.bottom + staff.gap) {
    last += 1;
  }
  const connectionGap = Math.max(8, Math.min(32, staff.gap * 2.5));
  while (first > 0 && bands[first].top - bands[first - 1].bottom <= connectionGap) {
    first -= 1;
  }
  while (last + 1 < bands.length && bands[last + 1].top - bands[last].bottom <= connectionGap) {
    last += 1;
  }
  return { top: bands[first].top, bottom: bands[last].bottom };
}

export function hammingDistance(left: Uint8Array, right: Uint8Array): number {
  if (left.length !== right.length) {
    return Number.POSITIVE_INFINITY;
  }
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) {
    let difference = left[index] ^ right[index];
    while (difference !== 0) {
      distance += difference & 1;
      difference >>>= 1;
    }
  }
  return distance;
}

export function isNearDuplicate(left: Uint8Array, right: Uint8Array): boolean {
  const threshold = Math.min(10, Math.max(1, Math.floor(left.length * 8 * 0.08)));
  return hammingDistance(left, right) <= threshold;
}

function isPaperBacked(frame: PreprocessedFrame, rect: Rect): boolean {
  const top = Math.max(0, Math.floor(rect.y));
  const bottom = Math.min(frame.height, Math.ceil(rect.y + rect.height));
  let brightPixels = 0;
  for (let y = top; y < bottom; y += 1) {
    brightPixels += frame.rowBrightCounts[y];
  }
  return brightPixels / Math.max(1, (bottom - top) * frame.width) >= 0.55;
}

function findPaperEdge(frame: PreprocessedFrame, anchor: number, limit: number, direction: -1 | 1): number {
  let edge = anchor;
  let nonPaperRun = 0;
  for (let y = anchor; direction === 1 ? y < limit : y >= limit; y += direction) {
    const brightRatio = frame.rowBrightCounts[y] / frame.width;
    if (brightRatio >= 0.55) {
      edge = direction === 1 ? y + 1 : y;
      nonPaperRun = 0;
      continue;
    }
    nonPaperRun += 1;
    if (nonPaperRun >= NON_PAPER_BOUNDARY_ROWS) {
      break;
    }
  }
  return edge;
}

function estimateThreshold(grayscale: Uint8Array): number {
  let total = 0;
  let samples = 0;
  for (let index = 0; index < grayscale.length; index += 16) {
    total += grayscale[index];
    samples += 1;
  }
  const mean = samples === 0 ? SIMPLE_THRESHOLD : total / samples;
  return Math.max(90, Math.min(SIMPLE_THRESHOLD, mean - 18));
}
