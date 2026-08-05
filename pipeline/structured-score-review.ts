import { createScoreReview, type ScoreReview, type ScoreReviewDecisionInput } from "./score-review-contract";
import type { MuseScoreRenderResult, MuseScoreRenderedPage, StructuredPageObservation } from "./musescore-adapter";
import { PDFDocument, type PDFPage } from "pdf-lib";
import { PDFArray, PDFRawStream, decodePDFRawStream } from "pdf-lib/cjs/core";

export type StructuredScoreSelection = {
  readonly review: ScoreReview;
  readonly selectedPdfPath: string;
};

export type StructuredScoreReviewInput = {
  readonly pageCount: number;
  readonly rasterPdfPath: string;
  readonly render: MuseScoreRenderResult;
};

export function reviewStructuredScore(input: StructuredScoreReviewInput): StructuredScoreSelection {
  if (!input.render.ok) return fallback(input.pageCount, input.rasterPdfPath, input.render.failures);
  if (input.render.pages.length !== input.pageCount) {
    return fallback(input.pageCount, input.rasterPdfPath, [{ pageNumber: null, code: "STRUCTURED_LINEAGE_MISMATCH", evidence: { expectedPageNumber: input.pageCount, actualPageNumber: input.render.pages.length } }]);
  }
  for (let index = 0; index < input.render.pages.length; index += 1) {
    const page = input.render.pages[index];
    if (page === undefined) continue;
    const failure = comparePage(page, index + 1);
    if (failure !== null) return fallback(input.pageCount, input.rasterPdfPath, [failure]);
  }
  return {
    review: createScoreReview({ disposition: "structured", rasterSafe: true, decisions: [{ pageNumber: null, code: "STRUCTURED_SELECTED", evidence: { pageCount: input.pageCount } }] }),
    selectedPdfPath: input.render.outputPath
  };
}

export async function inspectStructuredPdfPage(pageNumber: number, bytes: Uint8Array): Promise<StructuredPageObservation> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  if (document.getPageCount() !== 1) throw new TypeError("inspection-page-count");
  const page = document.getPage(0);
  const segments = horizontalSegments(pageContent(page));
  const staffLines = [...new Set(segments.filter((line) => line.width >= page.getWidth() * 0.4).map((line) => Math.round(line.y * 4) / 4))].sort((left, right) => right - left);
  const staves = findStaves(staffLines);
  if (staves.length === 0) throw new TypeError("staff-observation");
  let systemCount = 1;
  for (let index = 1; index < staves.length; index += 1) {
    const previous = staves[index - 1];
    const current = staves[index];
    if (previous !== undefined && current !== undefined && previous.bottom - current.top > Math.max(previous.gap, current.gap) * 8) systemCount += 1;
  }
  const boundaryInk = segments.some((line) => line.left <= 0.5 || line.right >= page.getWidth() - 0.5 || line.y <= 0.5 || line.y >= page.getHeight() - 0.5);
  return { outputPageNumber: pageNumber, systemCount, staffGroupCount: staves.length, boundaryInk };
}

type HorizontalSegment = { readonly left: number; readonly right: number; readonly width: number; readonly y: number };
type Staff = { readonly top: number; readonly bottom: number; readonly gap: number };

function pageContent(page: PDFPage): string {
  const contents = page.node.Contents();
  if (contents === undefined) return "";
  if (contents instanceof PDFRawStream) return Buffer.from(decodePDFRawStream(contents).decode()).toString("ascii");
  if (!(contents instanceof PDFArray)) return "";
  return Array.from({ length: contents.size() }, (_, index) => {
    const stream = contents.lookupMaybe(index, PDFRawStream);
    return stream === undefined ? "" : Buffer.from(decodePDFRawStream(stream).decode()).toString("ascii");
  }).join("\n");
}

function horizontalSegments(content: string): readonly HorizontalSegment[] {
  const number = "[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)";
  const lines = new RegExp(`(${number})\\s+(${number})\\s+m\\s+(?:${number}\\s+${number}\\s+m\\s+)?(${number})\\s+(${number})\\s+l\\s+S`, "gu");
  const rectangles = new RegExp(`(${number})\\s+(${number})\\s+(${number})\\s+(${number})\\s+re\\s+[fF]`, "gu");
  const segments: HorizontalSegment[] = [];
  for (const match of content.matchAll(lines)) {
    const x1 = finite(match[1]);
    const y1 = finite(match[2]);
    const x2 = finite(match[3]);
    const y2 = finite(match[4]);
    if (Math.abs(y1 - y2) <= 0.75) segments.push(segment(x1, x2, (y1 + y2) / 2));
  }
  for (const match of content.matchAll(rectangles)) {
    const x = finite(match[1]);
    const y = finite(match[2]);
    const width = finite(match[3]);
    const height = finite(match[4]);
    if (Math.abs(height) <= 2 && Math.abs(width) > 0) segments.push(segment(x, x + width, y + height / 2));
  }
  return segments;
}

function findStaves(lines: readonly number[]): readonly Staff[] {
  const staves: Staff[] = [];
  for (let index = 0; index + 4 < lines.length;) {
    const group = lines.slice(index, index + 5);
    const gaps = group.slice(0, 4).map((line, gapIndex) => line - (group[gapIndex + 1] ?? line));
    const minimum = Math.min(...gaps);
    const maximum = Math.max(...gaps);
    if (minimum >= 1 && maximum <= minimum * 1.25) {
      const top = group[0];
      const bottom = group[4];
      if (top !== undefined && bottom !== undefined) staves.push({ top, bottom, gap: gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length });
      index += 5;
    } else index += 1;
  }
  return staves;
}

function segment(x1: number, x2: number, y: number): HorizontalSegment {
  const left = Math.min(x1, x2);
  const right = Math.max(x1, x2);
  return { left, right, width: right - left, y };
}

function finite(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new TypeError("pdf-number");
  return parsed;
}

function comparePage(page: MuseScoreRenderedPage, expectedPageNumber: number): ScoreReviewDecisionInput | null {
  if (page.pageNumber !== expectedPageNumber || page.outputPageNumber !== expectedPageNumber) {
    return { pageNumber: page.pageNumber, code: "STRUCTURED_LINEAGE_MISMATCH", evidence: { expectedPageNumber, actualPageNumber: page.outputPageNumber } };
  }
  if (!positiveInteger(page.sourceSystemCount) || !positiveInteger(page.systemCount) || Math.abs(page.systemCount - page.sourceSystemCount) > 1) {
    return invalid(page.pageNumber, "system-count-delta");
  }
  const ratio = page.staffGroupCount / page.sourceStaffGroupCount;
  if (!positiveInteger(page.sourceStaffGroupCount) || !positiveInteger(page.staffGroupCount) || ratio < 0.8 || ratio > 1.25) {
    return invalid(page.pageNumber, "staff-group-ratio");
  }
  if (page.boundaryInk) return invalid(page.pageNumber, "boundary-ink");
  return null;
}

function fallback(pageCount: number, rasterPdfPath: string, failures: readonly ScoreReviewDecisionInput[]): StructuredScoreSelection {
  return {
    review: createScoreReview({ disposition: "raster-fallback", rasterSafe: true, decisions: [...failures, { pageNumber: null, code: "RASTER_FALLBACK_SELECTED", evidence: { pageCount } }] }),
    selectedPdfPath: rasterPdfPath
  };
}

function invalid(pageNumber: number, validationReason: string): ScoreReviewDecisionInput {
  return { pageNumber, code: "STRUCTURED_PDF_INVALID", evidence: { validationReason } };
}

function positiveInteger(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }
