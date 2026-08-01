export type ScorePdfPageLayout = {
  readonly pageWidth: number;
  readonly pageHeight: number;
  readonly padding: number;
  readonly gap: number;
};

export type ScorePdfContract = ScorePdfPageLayout & {
  readonly rasterWidth: number;
  readonly rasterHeight: number;
  readonly targetDpi: number;
};

export const STANDALONE_SCORE_PDF = {
  rasterWidth: 1200,
  rasterHeight: 1700,
  pageWidth: 1200,
  pageHeight: 1700,
  padding: 16,
  gap: 12,
  targetDpi: 72
} as const satisfies ScorePdfContract;

export const SCORE_PDF_METADATA = {
  subject: "Score sheets extracted from user-supplied video",
  keywords: ["yt2sheet", "sheet music", "score export"],
  creator: "yt2sheet",
  producer: "yt2sheet 0.1.0"
} as const;
