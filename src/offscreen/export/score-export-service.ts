import type { CapturedScoreSystem } from "../../shared/capture-types";
import type { ScorePage } from "../../shared/page-types";
import type { ImageBlobRepository } from "../capture/image-blob-repository";
import { BlobScorePageImageRepository, type ScorePageImageRepository } from "./score-page-image-repository";
import { ScorePageChunker } from "./score-page-chunker";
import { ScorePageRenderer } from "./score-page-renderer";
import { ScorePdfExporter } from "./score-pdf-exporter";

type PageRendererLike = Pick<ScorePageRenderer, "render">;

export class ScoreExportService {
  constructor(
    private readonly imageBlobRepository: ImageBlobRepository,
    private readonly chunker = new ScorePageChunker(),
    private readonly pageRenderer: PageRendererLike = new ScorePageRenderer(imageBlobRepository),
    private readonly pageImageRepository: ScorePageImageRepository = new BlobScorePageImageRepository(imageBlobRepository),
    private readonly pdfExporter = new ScorePdfExporter()
  ) {}

  async createRenderedPages(sessionId: string, systems: CapturedScoreSystem[]): Promise<ScorePage[]> {
    const pages = this.chunker.createPages(sessionId, systems);
    const renderedPages: ScorePage[] = [];

    for (const page of pages) {
      const blob = await this.pageRenderer.render(page.pageIndex, page.systems);
      renderedPages.push(await this.pageImageRepository.savePageImage(page, blob));
    }

    return renderedPages;
  }

  async exportPngPages(sessionId: string, systems: CapturedScoreSystem[]): Promise<Blob[]> {
    const pages = await this.createRenderedPages(sessionId, systems);
    return Promise.all(pages.map((page) => this.pageImageRepository.loadPageImage(page)));
  }

  async exportPdf(sessionId: string, systems: CapturedScoreSystem[]): Promise<Blob> {
    const pageImages = await this.exportPngPages(sessionId, systems);
    return this.pdfExporter.export(pageImages);
  }
}
