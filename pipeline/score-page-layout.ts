import { STANDALONE_SCORE_PDF } from "./score-identity-config";
import type { ScorePdfPageLayout } from "./score-identity-config";

export type ScoreImageSize = {
  readonly width: number;
  readonly height: number;
};

export type ScoreImagePlacement = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type ScorePageLayoutConfig = ScorePdfPageLayout;

type SizedScore = {
  readonly image: ScoreImageSize;
};

export function packScorePages<T extends SizedScore>(scores: readonly T[], layout: ScorePageLayoutConfig = STANDALONE_SCORE_PDF): T[][] {
  const { pageWidth, pageHeight, padding, gap } = layout;
  const contentWidth = pageWidth - padding * 2;
  const contentHeight = pageHeight - padding * 2;
  const pages: T[][] = [];
  let page: T[] = [];
  let usedHeight = 0;

  for (const score of scores) {
    const fittedHeight = fitToContentWidth(score.image, contentWidth).height;
    const requiredHeight = fittedHeight + (page.length > 0 ? gap : 0);

    if (page.length > 0 && usedHeight + requiredHeight > contentHeight) {
      pages.push(page);
      page = [];
      usedHeight = 0;
    }

    usedHeight += fittedHeight + (page.length > 0 ? gap : 0);
    page.push(score);
  }

  if (page.length > 0) {
    pages.push(page);
  }

  return pages;
}

export function computeScorePagePlacements(imageSizes: ScoreImageSize[], layout: ScorePageLayoutConfig = STANDALONE_SCORE_PDF): ScoreImagePlacement[] {
  const { pageWidth, pageHeight, padding, gap } = layout;
  const contentWidth = pageWidth - padding * 2;
  const contentHeight = pageHeight - padding * 2;

  if (imageSizes.length === 0) {
    return [];
  }

  const widthFit = imageSizes.map((size) => fitToContentWidth(size, contentWidth));
  const totalGap = gap * Math.max(0, imageSizes.length - 1);
  const totalHeight = widthFit.reduce((sum, size) => sum + size.height, 0) + totalGap;
  const compression = totalHeight > contentHeight
    ? Math.max(1, contentHeight - totalGap) / Math.max(1, totalHeight - totalGap)
    : 1;
  const renderedHeight = widthFit.reduce((sum, size) => sum + size.height * compression, 0);
  const groupHeight = renderedHeight + totalGap;

  const placements: ScoreImagePlacement[] = [];
  let y = padding;

  for (const size of widthFit) {
    const width = size.width * compression;
    const height = size.height * compression;
    placements.push({
      x: padding + (contentWidth - width) / 2,
      y,
      width,
      height
    });
    y += height + gap;
  }

  return placements;
}

function fitToContentWidth(size: ScoreImageSize, contentWidth: number): ScoreImageSize {
  const scale = contentWidth / Math.max(1, size.width);
  return {
    width: Math.max(1, size.width * scale),
    height: Math.max(1, size.height * scale)
  };
}
