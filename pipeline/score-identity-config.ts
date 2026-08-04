import packageMetadata from "../package.json";

export type ScoreRasterPageLayout = {
  readonly rasterWidth: number;
  readonly rasterHeight: number;
  readonly contentMarginPixels: number;
  readonly interSheetGapPixels: number;
};

export type ScorePdfContract = ScoreRasterPageLayout & {
  readonly pdfPageWidthPoints: number;
  readonly pdfPageHeightPoints: number;
  readonly contentMarginMillimetres: number;
  readonly interSheetGapMillimetres: number;
  readonly targetDpi: number;
};

export const STANDALONE_SCORE_PDF = {
  pdfPageWidthPoints: 595.2755905511812,
  pdfPageHeightPoints: 841.8897637795276,
  rasterWidth: 1200,
  rasterHeight: 1697,
  contentMarginMillimetres: 10,
  contentMarginPixels: 57,
  interSheetGapMillimetres: 4,
  interSheetGapPixels: 23,
  targetDpi: 145.14
} as const satisfies ScorePdfContract;

export const SCORE_PDF_METADATA = {
  subject: "Score sheets extracted from user-supplied video",
  keywords: ["yt2sheet", "sheet music", "score export"],
  creator: "yt2sheet",
  producer: `${packageMetadata.name} ${packageMetadata.version}`
} as const;
