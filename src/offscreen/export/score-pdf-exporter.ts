import { PDFDocument } from "pdf-lib";
import { SCORE_IDENTITY_CONFIG } from "../../shared/score-identity-config";

export class ScorePdfExporter {
  async export(pageImages: Blob[]): Promise<Blob> {
    const pdfDoc = await PDFDocument.create();
    const { pageWidth, pageHeight } = SCORE_IDENTITY_CONFIG.page;

    for (const pageImage of pageImages) {
      const imageBytes = await pageImage.arrayBuffer();
      const pngImage = await pdfDoc.embedPng(imageBytes);
      const page = pdfDoc.addPage([pageWidth, pageHeight]);

      page.drawImage(pngImage, {
        x: 0,
        y: 0,
        width: pageWidth,
        height: pageHeight
      });
    }

    const pdfBytes = await pdfDoc.save();
    const bytes = new Uint8Array(pdfBytes);
    return new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)], { type: "application/pdf" });
  }
}
