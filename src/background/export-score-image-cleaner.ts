import type { DebugUniqueScore } from "../shared/messages";
import { cleanScorePixels, cropPixelFrame, type PixelFrame } from "./score-image-cleanup";

export type ExportScoreImageCleaner = {
  clean(score: DebugUniqueScore, candidates: readonly DebugUniqueScore[]): Promise<DebugUniqueScore>;
};

export class BrowserExportScoreImageCleaner implements ExportScoreImageCleaner {
  async clean(score: DebugUniqueScore, candidates: readonly DebugUniqueScore[]): Promise<DebugUniqueScore> {
    if (!score.image.dataUrl || typeof createImageBitmap !== "function" || typeof OffscreenCanvas === "undefined") {
      return score;
    }

    try {
      const primary = await decodePixelFrame(score.image.dataUrl);
      const alternatives = await decodeAlternatives(score, candidates);
      const cleanup = cleanScorePixels(primary, alternatives);
      const cropped = cropPixelFrame(cleanup.frame, cleanup.crop);
      if (cleanup.repairedPixelCount === 0 && cropped.width === primary.width && cropped.height === primary.height) {
        return score;
      }

      return {
        ...score,
        image: {
          ...score.image,
          dataUrl: await encodePixelFrame(cropped),
          width: cropped.width,
          height: cropped.height
        }
      };
    } catch {
      return score;
    }
  }
}

async function decodeAlternatives(
  score: DebugUniqueScore,
  candidates: readonly DebugUniqueScore[]
): Promise<PixelFrame[]> {
  const seen = new Set<string>([score.image.imageBlobId, score.image.dataUrl ?? ""]);
  const dataUrls: string[] = [];
  for (const candidate of candidates) {
    const dataUrl = candidate.image.dataUrl;
    if (
      !dataUrl ||
      candidate.image.width !== score.image.width ||
      candidate.image.height !== score.image.height ||
      seen.has(candidate.image.imageBlobId) ||
      seen.has(dataUrl)
    ) {
      continue;
    }
    seen.add(candidate.image.imageBlobId);
    seen.add(dataUrl);
    dataUrls.push(dataUrl);
  }

  const decoded = await Promise.allSettled(dataUrls.slice(0, 4).map(decodePixelFrame));
  return decoded.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
}

async function decodePixelFrame(dataUrl: string): Promise<PixelFrame> {
  const bitmap = await createImageBitmap(dataUrlToBlob(dataUrl));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    bitmap.close();
    throw new Error("Canvas context is not available.");
  }
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  return { width: image.width, height: image.height, data: image.data };
}

async function encodePixelFrame(frame: PixelFrame): Promise<string> {
  const canvas = new OffscreenCanvas(frame.width, frame.height);
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas context is not available.");
  }
  const image = context.createImageData(frame.width, frame.height);
  image.data.set(frame.data);
  context.putImageData(image, 0, 0);
  return blobToDataUrl(await canvas.convertToBlob({ type: "image/png" }));
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [header, payload] = dataUrl.split(",");
  const mimeType = /^data:([^;]+);base64$/.exec(header ?? "")?.[1] ?? "image/png";
  const binary = atob(payload ?? "");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 32_768;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
  }
  return `data:${blob.type || "image/png"};base64,${btoa(binary)}`;
}
