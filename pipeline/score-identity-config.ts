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

const POINTS_PER_INCH = 72;
const MILLIMETRES_PER_INCH = 25.4;
const OMR_REVIEW_DPI = 300;

export const OMR_REVIEW_PAGE_LAYOUT = {
  rasterWidth: Math.round(STANDALONE_SCORE_PDF.pdfPageWidthPoints / POINTS_PER_INCH * OMR_REVIEW_DPI),
  rasterHeight: Math.round(STANDALONE_SCORE_PDF.pdfPageHeightPoints / POINTS_PER_INCH * OMR_REVIEW_DPI),
  contentMarginPixels: Math.round(STANDALONE_SCORE_PDF.contentMarginMillimetres / MILLIMETRES_PER_INCH * OMR_REVIEW_DPI),
  interSheetGapPixels: Math.round(STANDALONE_SCORE_PDF.interSheetGapMillimetres / MILLIMETRES_PER_INCH * OMR_REVIEW_DPI)
} as const satisfies ScoreRasterPageLayout;

export const SCORE_PDF_METADATA = {
  subject: "Score sheets extracted from user-supplied video",
  keywords: ["yt2sheet", "sheet music", "score export"],
  creator: "yt2sheet",
  producer: `${packageMetadata.name} ${packageMetadata.version}`
} as const;
