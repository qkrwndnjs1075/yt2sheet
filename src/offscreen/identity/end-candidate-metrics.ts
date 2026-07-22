import type { NormalizedScoreImage } from "../../shared/fingerprint-types";
import { detectStaffRowRuns, findStaffContentRect, type PixelRect } from "./staff-content-extractor";

const DARK_THRESHOLD = 150;

export type EndGateThresholds = {
  maxEndCandidateCropAreaDiff: number;
  maxEndCandidateInkDensityDiff: number;
  maxOverlayDominantRegionRatio: number;
};

export type EndCandidateMetrics = {
  staffRowRunCount: number;
  staffContentRect: PixelRect;
  staffContentAreaRatio: number;
  inkDensity: number;
  dominantRegionRatio: number;
};

export function measureEndCandidate(image: NormalizedScoreImage): EndCandidateMetrics {
  const pixelAt = (x: number, y: number) => image.pixels[y * image.width + x] ?? 255;
  const staffRows = detectStaffRowRuns(image.width, image.height, pixelAt);
  const staffContentRect = findStaffContentRect(image.width, image.height, pixelAt);
  const totalPixels = Math.max(1, image.width * image.height);
  let darkPixels = 0;

  for (let index = 0; index < image.pixels.length; index += 1) {
    if ((image.pixels[index] ?? 255) < DARK_THRESHOLD) {
      darkPixels += 1;
    }
  }

  return {
    staffRowRunCount: staffRows.length,
    staffContentRect,
    staffContentAreaRatio: (staffContentRect.width * staffContentRect.height) / totalPixels,
    inkDensity: darkPixels / totalPixels,
    dominantRegionRatio: largestDarkComponentRatio(image)
  };
}

export function isScoreLikeEndCandidate(
  current: EndCandidateMetrics,
  previous: EndCandidateMetrics | null,
  thresholds: EndGateThresholds
): boolean {
  if (current.staffRowRunCount < 3) {
    return false;
  }

  if (current.dominantRegionRatio > thresholds.maxOverlayDominantRegionRatio) {
    return false;
  }

  if (!previous) {
    return true;
  }

  if (Math.abs(current.staffContentAreaRatio - previous.staffContentAreaRatio) > thresholds.maxEndCandidateCropAreaDiff) {
    return false;
  }

  return Math.abs(current.inkDensity - previous.inkDensity) <= thresholds.maxEndCandidateInkDensityDiff;
}

function largestDarkComponentRatio(image: NormalizedScoreImage): number {
  const totalPixels = Math.max(1, image.width * image.height);
  const visited = new Uint8Array(totalPixels);
  let largest = 0;

  for (let index = 0; index < totalPixels; index += 1) {
    if (visited[index] || !isDarkIndex(image, index)) {
      continue;
    }

    largest = Math.max(largest, floodFillDarkComponent(image, index, visited));
  }

  return largest / totalPixels;
}

function floodFillDarkComponent(image: NormalizedScoreImage, startIndex: number, visited: Uint8Array): number {
  const stack = [startIndex];
  let count = 0;

  while (stack.length > 0) {
    const index = stack.pop() ?? 0;
    if (visited[index] || !isDarkIndex(image, index)) {
      continue;
    }

    visited[index] = 1;
    count += 1;

    const x = index % image.width;
    const y = Math.floor(index / image.width);
    pushNeighbor(stack, image, visited, x - 1, y);
    pushNeighbor(stack, image, visited, x + 1, y);
    pushNeighbor(stack, image, visited, x, y - 1);
    pushNeighbor(stack, image, visited, x, y + 1);
  }

  return count;
}

function pushNeighbor(stack: number[], image: NormalizedScoreImage, visited: Uint8Array, x: number, y: number): void {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) {
    return;
  }

  const index = y * image.width + x;
  if (!visited[index] && isDarkIndex(image, index)) {
    stack.push(index);
  }
}

function isDarkIndex(image: NormalizedScoreImage, index: number): boolean {
  return (image.pixels[index] ?? 255) < DARK_THRESHOLD;
}
