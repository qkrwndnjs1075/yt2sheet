import type { OffscreenInputFrame } from "../frame-sink";
import type { PreprocessedFrame } from "./preprocessed-frame";
import type { Rect } from "../../shared/layout-types";

const ANALYSIS_WIDTH = 960;
const SIMPLE_THRESHOLD = 180;
const BRIGHT_PIXEL_THRESHOLD = 205;
const EDGE_DELTA_THRESHOLD = 34;

export class ImagePreprocessor {
  run(frame: OffscreenInputFrame, sourceRect: Rect = { x: 0, y: 0, width: frame.image.width, height: frame.image.height }): PreprocessedFrame {
    const scale = Math.min(1, ANALYSIS_WIDTH / sourceRect.width);
    const width = Math.max(1, Math.round(sourceRect.width * scale));
    const height = Math.max(1, Math.round(sourceRect.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      throw new Error("Unable to create analysis canvas context.");
    }

    context.drawImage(frame.image.bitmapRef, sourceRect.x, sourceRect.y, sourceRect.width, sourceRect.height, 0, 0, width, height);
    const image = context.getImageData(0, 0, width, height);
    const binary = new Uint8Array(width * height);
    const grayscale = new Uint8Array(width * height);
    const rowDarkCounts = Array.from({ length: height }, () => 0);
    const rowLineScores = Array.from({ length: height }, () => 0);
    const rowBrightCounts = Array.from({ length: height }, () => 0);
    const rowEdgeScores = Array.from({ length: height }, () => 0);
    const threshold = estimateThreshold(image.data);

    for (let y = 0; y < height; y += 1) {
      let longestRun = 0;
      let currentRun = 0;

      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        const gray = image.data[offset] * 0.299 + image.data[offset + 1] * 0.587 + image.data[offset + 2] * 0.114;
        const dark = gray < threshold ? 1 : 0;
        grayscale[y * width + x] = gray;
        binary[y * width + x] = dark;

        if (dark) {
          rowDarkCounts[y] += 1;
          currentRun += 1;
          longestRun = Math.max(longestRun, currentRun);
        } else {
          currentRun = 0;
        }

        if (gray >= BRIGHT_PIXEL_THRESHOLD) {
          rowBrightCounts[y] += 1;
        }

        if (x > 0 && Math.abs(gray - grayscale[y * width + x - 1]) >= EDGE_DELTA_THRESHOLD) {
          rowEdgeScores[y] += 1;
        }
      }

      rowLineScores[y] = Math.max(rowDarkCounts[y] / width, longestRun / width);
      rowEdgeScores[y] /= width;
    }

    return {
      frameId: frame.id,
      width,
      height,
      originalWidth: frame.image.width,
      originalHeight: frame.image.height,
      sourceRect,
      analysisScale: scale,
      binary,
      rowDarkCounts,
      rowLineScores,
      rowEdgeScores,
      rowBrightCounts,
      threshold
    };
  }
}

function estimateThreshold(data: Uint8ClampedArray): number {
  let total = 0;
  const sampleStride = 16;
  let samples = 0;

  for (let index = 0; index < data.length; index += 4 * sampleStride) {
    total += data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
    samples += 1;
  }

  const mean = samples === 0 ? SIMPLE_THRESHOLD : total / samples;
  return Math.max(90, Math.min(SIMPLE_THRESHOLD, mean - 18));
}
