import type { OffscreenInputFrame } from "../../frame-sink";
import { CONTACT_SHEET_CELL_SIZE, type CandidateContactSheet, type CandidateForJudge } from "./candidate-judge-types";

type ContactSheetCanvas = HTMLCanvasElement | OffscreenCanvas;
type ContactSheetContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export class CandidateContactSheetBuilder {
  constructor(private readonly cellSize = CONTACT_SHEET_CELL_SIZE) {}

  async build(frame: OffscreenInputFrame, candidates: CandidateForJudge[]): Promise<CandidateContactSheet> {
    if (candidates.length === 0) {
      throw new Error("Cannot build a contact sheet without candidates.");
    }

    const columns = Math.min(4, candidates.length);
    const rows = Math.ceil(candidates.length / columns);
    const canvas = createCanvas(columns * this.cellSize, rows * this.cellSize);
    const context = canvas.getContext("2d") as ContactSheetContext | null;

    if (!context) {
      throw new Error("Unable to create contact sheet canvas context.");
    }

    paintBackground(context, canvas.width, canvas.height);
    candidates.forEach((candidate, index) => {
      this.drawCandidate(context, frame, candidate, index, columns);
    });

    return {
      base64: await canvasToBase64(canvas, "image/jpeg", 0.82),
      mediaType: "image/jpeg",
      candidateIds: candidates.map((candidate) => candidate.id),
      width: canvas.width,
      height: canvas.height
    };
  }

  private drawCandidate(context: ContactSheetContext, frame: OffscreenInputFrame, candidate: CandidateForJudge, index: number, columns: number): void {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const cellX = column * this.cellSize;
    const cellY = row * this.cellSize;
    const labelHeight = 34;
    const padding = 10;
    const targetWidth = this.cellSize - padding * 2;
    const targetHeight = this.cellSize - labelHeight - padding * 2;
    const scale = Math.min(targetWidth / Math.max(1, candidate.rect.width), targetHeight / Math.max(1, candidate.rect.height));
    const drawWidth = Math.max(1, candidate.rect.width * scale);
    const drawHeight = Math.max(1, candidate.rect.height * scale);
    const drawX = cellX + padding + (targetWidth - drawWidth) / 2;
    const drawY = cellY + labelHeight + padding + (targetHeight - drawHeight) / 2;

    context.save();
    context.fillStyle = "#ffffff";
    context.fillRect(cellX, cellY, this.cellSize, this.cellSize);
    context.strokeStyle = "#111827";
    context.lineWidth = 2;
    context.strokeRect(cellX + 1, cellY + 1, this.cellSize - 2, this.cellSize - 2);
    context.drawImage(
      frame.image.bitmapRef,
      candidate.rect.x,
      candidate.rect.y,
      candidate.rect.width,
      candidate.rect.height,
      drawX,
      drawY,
      drawWidth,
      drawHeight
    );
    context.fillStyle = "#111827";
    context.fillRect(cellX, cellY, this.cellSize, labelHeight);
    context.fillStyle = "#ffffff";
    context.font = "bold 24px system-ui, sans-serif";
    context.textBaseline = "middle";
    context.fillText(candidate.id, cellX + 12, cellY + labelHeight / 2);
    context.restore();
  }
}

function createCanvas(width: number, height: number): ContactSheetCanvas {
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  return new OffscreenCanvas(width, height);
}

function paintBackground(context: ContactSheetContext, width: number, height: number): void {
  context.fillStyle = "#f3f4f6";
  context.fillRect(0, 0, width, height);
}

async function canvasToBase64(canvas: ContactSheetCanvas, mediaType: "image/jpeg", quality: number): Promise<string> {
  if ("toDataURL" in canvas) {
    return dataUrlToBase64(canvas.toDataURL(mediaType, quality));
  }

  const blob = await canvas.convertToBlob({ type: mediaType, quality });
  return arrayBufferToBase64(await blob.arrayBuffer());
}

function dataUrlToBase64(dataUrl: string): string {
  const marker = ";base64,";
  const index = dataUrl.indexOf(marker);
  return index === -1 ? dataUrl : dataUrl.slice(index + marker.length);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
