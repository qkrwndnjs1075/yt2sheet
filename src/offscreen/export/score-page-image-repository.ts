import type { ScorePage } from "../../shared/page-types";
import type { ImageBlobRepository } from "../capture/image-blob-repository";

export interface ScorePageImageRepository {
  savePageImage(page: ScorePage, blob: Blob): Promise<ScorePage>;
  loadPageImage(page: ScorePage): Promise<Blob>;
}

export class BlobScorePageImageRepository implements ScorePageImageRepository {
  constructor(private readonly imageBlobRepository: ImageBlobRepository) {}

  async savePageImage(page: ScorePage, blob: Blob): Promise<ScorePage> {
    const imageBlobId = `score-page:${page.sessionId}:${page.pageIndex + 1}`;
    await this.imageBlobRepository.saveBlob(imageBlobId, blob, {
      width: page.width,
      height: page.height,
      type: blob.type || "image/png"
    });
    return {
      ...page,
      imageBlobId
    };
  }

  async loadPageImage(page: ScorePage): Promise<Blob> {
    if (!page.imageBlobId) {
      throw new Error(`Score page has no rendered image: ${page.id}`);
    }
    return this.imageBlobRepository.loadBlob(page.imageBlobId);
  }
}
