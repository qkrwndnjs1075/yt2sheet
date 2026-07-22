import type { CapturedScoreSystem } from "../../shared/capture-types";
import { computeScorePagePlacements } from "../../shared/score-page-layout";
import { SCORE_IDENTITY_CONFIG } from "../../shared/score-identity-config";
import type { ImageBlobRepository } from "../capture/image-blob-repository";
import { canvasToBlob, createCanvas } from "../capture/thumbnail-generator";

export class ScorePageRenderer {
  constructor(private readonly imageBlobRepository: ImageBlobRepository) {}

  async render(pageIndex: number, systems: CapturedScoreSystem[]): Promise<Blob> {
    void pageIndex;
    const { pageWidth, pageHeight } = SCORE_IDENTITY_CONFIG.page;
    const canvas = createCanvas(pageWidth, pageHeight);
    const context = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;

    if (!context) {
      throw new Error("Canvas context is not available");
    }

    context.fillStyle = "white";
    context.fillRect(0, 0, pageWidth, pageHeight);

    const images: ImageBitmap[] = [];
    for (const system of systems) {
      images.push(await this.imageBlobRepository.loadImageBitmap(system.image.imageBlobId));
    }
    const placements = computeScorePagePlacements(systems.map((system) => system.image));

    for (let index = 0; index < images.length; index += 1) {
      const placement = placements[index];
      if (!placement) {
        continue;
      }
      context.drawImage(images[index], placement.x, placement.y, placement.width, placement.height);
    }

    return canvasToBlob(canvas);
  }
}
