import { PDFDocument, type PDFImage } from "pdf-lib";
import type { DebugUniqueScore, PreviewScoreExportPage } from "../shared/messages";
import { computeScorePagePlacements, packScorePages } from "../shared/score-page-layout";
import { SCORE_IDENTITY_CONFIG } from "../shared/score-identity-config";
import { orderScoreOccurrences } from "../shared/score-occurrences";

type ExportPage = DebugUniqueScore[];
export type ScoreExportOptions = {
  occurrenceOrder?: string[];
  scoreOrder?: string[];
};

export async function exportScoresAsPdf(scores: DebugUniqueScore[], options: ScoreExportOptions = {}): Promise<Blob> {
  const pdfDoc = await PDFDocument.create();
  const { pageWidth, pageHeight } = SCORE_IDENTITY_CONFIG.page;

  for (const systems of chunkScorePages(scores, options)) {
    const page = pdfDoc.addPage([pageWidth, pageHeight]);
    const images = await Promise.all(systems.map((system) => embedScoreImage(pdfDoc, system)));
    const placements = computeScorePagePlacements(images.map((image, index) => ({
      width: systems[index]?.image.width || image.width,
      height: systems[index]?.image.height || image.height
    })));

    for (let index = 0; index < images.length; index += 1) {
      const placement = placements[index];
      if (!placement) {
        continue;
      }
      page.drawImage(images[index], {
        x: placement.x,
        y: pageHeight - placement.y - placement.height,
        width: placement.width,
        height: placement.height
      });
    }
  }

  const pdfBytes = await pdfDoc.save();
  const bytes = new Uint8Array(pdfBytes);
  return new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)], { type: "application/pdf" });
}

export async function exportScoresAsPngPages(scores: DebugUniqueScore[], options: ScoreExportOptions = {}): Promise<Blob[]> {
  const { pageWidth, pageHeight } = SCORE_IDENTITY_CONFIG.page;
  const blobs: Blob[] = [];

  for (const systems of chunkScorePages(scores, options)) {
    const canvas = new OffscreenCanvas(pageWidth, pageHeight);
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Canvas context is not available");
    }

    context.fillStyle = "white";
    context.fillRect(0, 0, pageWidth, pageHeight);

    const images = await Promise.all(systems.map(async (system) => {
      if (!system.image.dataUrl) {
        return null;
      }

      const imageBlob = dataUrlToBlob(system.image.dataUrl);
      return createImageBitmap(imageBlob);
    }));
    const placements = computeScorePagePlacements(images.map((image, index) => ({
      width: systems[index]?.image.width || image?.width || 1,
      height: systems[index]?.image.height || image?.height || 1
    })));

    for (let index = 0; index < images.length; index += 1) {
      const image = images[index];
      const placement = placements[index];
      if (!image || !placement) {
        continue;
      }
      context.drawImage(image, placement.x, placement.y, placement.width, placement.height);
      image.close();
    }

    blobs.push(await canvas.convertToBlob({ type: "image/png" }));
  }

  return blobs;
}

export function previewPageBlobs(pages: readonly PreviewScoreExportPage[]): Blob[] {
  if (pages.length === 0) {
    throw new Error("Approved preview has no pages.");
  }

  return pages.map((page, index) => {
    if (page.pageIndex !== index) {
      throw new Error("Approved preview pages are incomplete or out of order.");
    }

    const blob = dataUrlToBlob(page.dataUrl);
    if (blob.type !== "image/png") {
      throw new Error("Approved preview page must be a PNG image.");
    }
    return blob;
  });
}

export async function exportApprovedPreviewAsPdf(pages: readonly PreviewScoreExportPage[]): Promise<Blob> {
  const pdfDoc = await PDFDocument.create();
  const { pageWidth, pageHeight } = SCORE_IDENTITY_CONFIG.page;

  for (const pageBlob of previewPageBlobs(pages)) {
    const pageImage = await pdfDoc.embedPng(await pageBlob.arrayBuffer());
    const page = pdfDoc.addPage([pageWidth, pageHeight]);
    page.drawImage(pageImage, { x: 0, y: 0, width: pageWidth, height: pageHeight });
  }

  const pdfBytes = await pdfDoc.save();
  const bytes = new Uint8Array(pdfBytes);
  return new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)], { type: "application/pdf" });
}

export function chunkScorePages(scores: DebugUniqueScore[], options: ScoreExportOptions = {}): ExportPage[] {
  const exportableScores = scores.filter((score) => Boolean(score.image.dataUrl));
  const uniqueScores = shouldUseOccurrenceOrdering(exportableScores, options)
    ? orderScoreOccurrences(exportableScores, options)
    : Array.isArray(options.scoreOrder)
      ? orderByReviewedClusterIds(uniqueByClusterId(exportableScores), options.scoreOrder)
      : sortByFirstSeen(uniqueByClusterId(exportableScores));
  return packScorePages(uniqueScores);
}

function shouldUseOccurrenceOrdering(scores: DebugUniqueScore[], options: ScoreExportOptions): boolean {
  return Array.isArray(options.occurrenceOrder) || scores.some((score) => score.occurrenceId !== undefined || score.occurrenceOrder !== undefined);
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
  }

  return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
}

export function safeFileBaseName(value: string): string {
  const name = value
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return name.length > 0 ? name.slice(0, 80) : "score-export";
}

async function embedScoreImage(pdfDoc: PDFDocument, system: DebugUniqueScore): Promise<PDFImage> {
  if (!system.image.dataUrl) {
    throw new Error(`Captured score has no export image: ${system.clusterId}`);
  }

  const blob = dataUrlToBlob(system.image.dataUrl);
  const bytes = await blob.arrayBuffer();
  return blob.type === "image/jpeg" || blob.type === "image/jpg" ? pdfDoc.embedJpg(bytes) : pdfDoc.embedPng(bytes);
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [header, payload] = dataUrl.split(",");
  if (!header || !payload) {
    throw new Error("Invalid score image data URL.");
  }

  const mime = /^data:([^;]+);base64$/.exec(header)?.[1] ?? "application/octet-stream";
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Blob([bytes], { type: mime });
}

function uniqueByClusterId(scores: DebugUniqueScore[]): DebugUniqueScore[] {
  const map = new Map<string, DebugUniqueScore>();
  for (const score of scores) {
    if (!map.has(score.clusterId)) {
      map.set(score.clusterId, score);
    }
  }
  return [...map.values()];
}

function orderByReviewedClusterIds(scores: DebugUniqueScore[], scoreOrder: string[]): DebugUniqueScore[] {
  const byClusterId = new Map(scores.map((score) => [score.clusterId, score]));
  const ordered: DebugUniqueScore[] = [];
  const seen = new Set<string>();

  for (const clusterId of scoreOrder) {
    const score = byClusterId.get(clusterId);
    if (!score || seen.has(clusterId)) {
      continue;
    }

    ordered.push(score);
    seen.add(clusterId);
  }

  return ordered;
}

function sortByFirstSeen(scores: DebugUniqueScore[]): DebugUniqueScore[] {
  return [...scores].sort((a, b) => {
    const timeDiff = a.source.firstSeenSec - b.source.firstSeenSec;
    return timeDiff !== 0 ? timeDiff : a.order - b.order;
  });
}
