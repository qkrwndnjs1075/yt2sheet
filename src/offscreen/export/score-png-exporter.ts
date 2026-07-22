import type { ScorePage } from "../../shared/page-types";
import type { ImageBlobRepository } from "../capture/image-blob-repository";

export class ScorePngExporter {
  constructor(private readonly imageBlobRepository: ImageBlobRepository) {}

  async exportPages(pages: ScorePage[]): Promise<Blob[]> {
    return Promise.all(
      pages.map((page) => {
        if (!page.imageBlobId) {
          throw new Error(`Score page has no rendered image: ${page.id}`);
        }
        return this.imageBlobRepository.loadBlob(page.imageBlobId);
      })
    );
  }
}
