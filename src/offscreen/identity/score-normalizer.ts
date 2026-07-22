import { FINGERPRINT_HEIGHT, FINGERPRINT_WIDTH, type NormalizedScoreImage } from "../../shared/fingerprint-types";
import type { RoiSample } from "../../shared/roi-types";

type SourceCanvas = HTMLCanvasElement | OffscreenCanvas | ImageBitmap;

export class ScoreNormalizer {
  normalize(sample: RoiSample): NormalizedScoreImage {
    return normalizeCanvasImage(sample.image.bitmapRef, FINGERPRINT_WIDTH, FINGERPRINT_HEIGHT);
  }
}

export function normalizeCanvasImage(source: SourceCanvas, targetWidth = FINGERPRINT_WIDTH, targetHeight = FINGERPRINT_HEIGHT): NormalizedScoreImage {
  const sourceWidth = Math.max(1, "width" in source ? source.width : targetWidth);
  const sourceHeight = Math.max(1, "height" in source ? source.height : targetHeight);
  const sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = sourceWidth;
  sourceCanvas.height = sourceHeight;
  const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });

  if (!sourceContext) {
    throw new Error("Unable to create score normalization canvas context.");
  }

  sourceContext.fillStyle = "#fff";
  sourceContext.fillRect(0, 0, sourceWidth, sourceHeight);
  sourceContext.drawImage(source, 0, 0, sourceWidth, sourceHeight);
  const contentRect = findContentRect(sourceContext.getImageData(0, 0, sourceWidth, sourceHeight), sourceWidth, sourceHeight);

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });

  if (!context) {
    throw new Error("Unable to create score fingerprint canvas context.");
  }

  context.fillStyle = "#fff";
  context.fillRect(0, 0, targetWidth, targetHeight);
  const scale = Math.min(targetWidth / contentRect.width, targetHeight / contentRect.height);
  const drawWidth = Math.max(1, Math.round(contentRect.width * scale));
  const drawHeight = Math.max(1, Math.round(contentRect.height * scale));
  const dx = Math.floor((targetWidth - drawWidth) / 2);
  const dy = Math.floor((targetHeight - drawHeight) / 2);
  context.drawImage(sourceCanvas, contentRect.x, contentRect.y, contentRect.width, contentRect.height, dx, dy, drawWidth, drawHeight);

  return imageDataToNormalized(context.getImageData(0, 0, targetWidth, targetHeight));
}

export function imageDataToNormalized(imageData: ImageData): NormalizedScoreImage {
  const gray = new Uint8ClampedArray(imageData.width * imageData.height);
  let min = 255;
  let max = 0;

  for (let i = 0, pixelIndex = 0; i < imageData.data.length; i += 4, pixelIndex += 1) {
    const r = imageData.data[i] ?? 255;
    const g = imageData.data[i + 1] ?? 255;
    const b = imageData.data[i + 2] ?? 255;
    const saturation = (Math.max(r, g, b) - Math.min(r, g, b)) / Math.max(1, Math.max(r, g, b));
    const rawGray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    const value = saturation > 0.35 && rawGray > 80 ? Math.max(rawGray, 218) : rawGray;
    gray[pixelIndex] = value;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }

  if (max - min >= 12) {
    for (let i = 0; i < gray.length; i += 1) {
      gray[i] = Math.round(((gray[i] - min) / (max - min)) * 255);
    }
  }

  return {
    width: imageData.width,
    height: imageData.height,
    pixels: gray
  };
}

export function createNormalizedImage(width: number, height: number, pixels: number[] | Uint8ClampedArray): NormalizedScoreImage {
  return {
    width,
    height,
    pixels: Uint8ClampedArray.from(pixels)
  };
}

function findContentRect(imageData: ImageData, width: number, height: number): { x: number; y: number; width: number; height: number } {
  let left = width;
  let top = height;
  let right = 0;
  let bottom = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const r = imageData.data[offset] ?? 255;
      const g = imageData.data[offset + 1] ?? 255;
      const b = imageData.data[offset + 2] ?? 255;
      const gray = 0.299 * r + 0.587 * g + 0.114 * b;
      if (gray < 245) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x + 1);
        bottom = Math.max(bottom, y + 1);
      }
    }
  }

  if (right <= left || bottom <= top) {
    return { x: 0, y: 0, width, height };
  }

  const padding = 4;
  const x = Math.max(0, left - padding);
  const y = Math.max(0, top - padding);
  return {
    x,
    y,
    width: Math.min(width, right + padding) - x,
    height: Math.min(height, bottom + padding) - y
  };
}
