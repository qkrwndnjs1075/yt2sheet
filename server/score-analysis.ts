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

type WideComponent = {
  readonly top: number;
  readonly bottom: number;
  readonly height: number;
  readonly density: number;
};

export type ScoreCrop = Rect & {
  readonly staffGap: number;
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

export function findScoreCrop(frame: PreprocessedFrame): ScoreCrop | null {
  const paperBackedStaffs = new StaffCandidateDetector().find(frame, []).filter((staff) => isPaperBacked(frame, staff.rect));
  if (paperBackedStaffs.length === 0) {
    return null;
  }
  const wideComponents = findWideComponents(frame);
  const bottomBoundary = wideComponents
    .filter((component) => component.bottom >= frame.height - 1
      && component.height >= frame.height * 0.08
      && component.density >= 0.2)
    .reduce<number | null>((boundary, component) => boundary === null ? component.top : Math.min(boundary, component.top), null);
  const detectedStaffs = bottomBoundary === null
    ? paperBackedStaffs
    : paperBackedStaffs.filter((staff) => staff.rect.y + staff.rect.height <= bottomBoundary);
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
  const lowerLimit = Math.min(frame.originalHeight, Math.ceil(bottomLimit));
  const paperBottom = findPaperEdge(frame, Math.ceil(bottom), lowerLimit, 1);
  const wideBoundary = bottomBoundary ?? wideComponents
    .filter((component) => component.top >= bottom + largestGap && component.height >= Math.max(8, largestGap * 1.5))
    .reduce<number | null>((boundary, component) => boundary === null ? component.top : Math.min(boundary, component.top), null);
  const cropBottom = wideBoundary === null ? paperBottom : Math.min(paperBottom, wideBoundary);
  return { x: 0, y, width: frame.originalWidth, height: Math.max(1, cropBottom - y), staffGap: largestGap };
}

function findWideComponents(frame: PreprocessedFrame): WideComponent[] {
  const pixelCount = frame.width * frame.height;
  const visited = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  const minimumWidth = frame.width * 0.7;
  const components: WideComponent[] = [];

  for (let start = 0; start < pixelCount; start += 1) {
    if (visited[start] === 1 || frame.binary[start] === 0) continue;
    let head = 0;
    let tail = 1;
    let minX = start % frame.width;
    let maxX = minX;
    let minY = Math.floor(start / frame.width);
    let maxY = minY;
    queue[0] = start;
    visited[start] = 1;
    while (head < tail) {
      const pixel = queue[head++];
      const x = pixel % frame.width;
      const y = Math.floor(pixel / frame.width);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      for (const neighbor of [x > 0 ? pixel - 1 : -1, x + 1 < frame.width ? pixel + 1 : -1, y > 0 ? pixel - frame.width : -1, y + 1 < frame.height ? pixel + frame.width : -1]) {
        if (neighbor >= 0 && visited[neighbor] === 0 && frame.binary[neighbor] === 1) {
          visited[neighbor] = 1;
          queue[tail++] = neighbor;
        }
      }
    }
    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    if (width >= minimumWidth) {
      components.push({ top: minY, bottom: maxY, height, density: tail / (width * height) });
    }
  }
  return components;
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
