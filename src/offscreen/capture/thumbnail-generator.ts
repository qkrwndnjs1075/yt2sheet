import { SCORE_IDENTITY_CONFIG } from "../../shared/score-identity-config";
import type { ImageBlobRepository } from "./image-blob-repository";

const THUMBNAIL_MAX_WIDTH = 360;

export class ThumbnailGenerator {
  constructor(private readonly imageBlobRepository: ImageBlobRepository) {}

  async generate(sourceImageBlobId: string): Promise<string> {
    const image = await this.imageBlobRepository.loadImageBitmap(sourceImageBlobId);
    const scale = Math.min(1, THUMBNAIL_MAX_WIDTH / Math.max(1, image.width));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!context) {
      throw new Error("Unable to create thumbnail canvas context.");
    }

    context.fillStyle = "white";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const blob = await canvasToBlob(canvas);
    const thumbnailBlobId = thumbnailBlobIdFor(sourceImageBlobId);
    await this.imageBlobRepository.saveBlob(thumbnailBlobId, blob, { width, height, type: blob.type || "image/png" });
    return thumbnailBlobId;
  }
}

export function thumbnailBlobIdFor(sourceImageBlobId: string): string {
  return `roi-thumbnail:${sourceImageBlobId}`;
}

export type ThumbnailGeneratorLike = {
  generate(sourceImageBlobId: string): Promise<string>;
};

export type RenderCanvas = HTMLCanvasElement | OffscreenCanvas;

export function createCanvas(width: number, height: number): RenderCanvas {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export async function canvasToBlob(canvas: RenderCanvas): Promise<Blob> {
  if ("convertToBlob" in canvas && typeof canvas.convertToBlob === "function") {
    return canvas.convertToBlob({ type: "image/png" });
  }

  return new Promise<Blob>((resolve, reject) => {
    (canvas as HTMLCanvasElement).toBlob((blob: Blob | null) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Unable to encode canvas blob."));
      }
    }, "image/png");
  });
}

export function pageSize(): { width: number; height: number } {
  return {
    width: SCORE_IDENTITY_CONFIG.page.pageWidth,
    height: SCORE_IDENTITY_CONFIG.page.pageHeight
  };
}
