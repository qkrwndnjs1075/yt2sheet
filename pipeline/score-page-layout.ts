import { STANDALONE_SCORE_PDF } from "./score-identity-config";
import type { ScoreRasterPageLayout } from "./score-identity-config";

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

export type ScorePageLayoutConfig = ScoreRasterPageLayout;

type SizedScore = {
  readonly image: ScoreImageSize;
};

export function packScorePages<T extends SizedScore>(scores: readonly T[], layout: ScorePageLayoutConfig = STANDALONE_SCORE_PDF): T[][] {
  const { rasterWidth, rasterHeight, contentMarginPixels, interSheetGapPixels } = layout;
  const contentWidth = rasterWidth - contentMarginPixels * 2;
  const contentHeight = rasterHeight - contentMarginPixels * 2;
  const pages: T[][] = [];
  let page: T[] = [];
  let usedHeight = 0;

  for (const score of scores) {
    const fittedHeight = fitToContentWidth(score.image, contentWidth).height;
    const requiredHeight = fittedHeight + (page.length > 0 ? interSheetGapPixels : 0);

    if (page.length > 0 && usedHeight + requiredHeight > contentHeight) {
      pages.push(page);
      page = [];
      usedHeight = 0;
    }

    usedHeight += fittedHeight + (page.length > 0 ? interSheetGapPixels : 0);
    page.push(score);
  }

  if (page.length > 0) {
    pages.push(page);
  }

  return pages;
}

export function computeScorePagePlacements(imageSizes: ScoreImageSize[], layout: ScorePageLayoutConfig = STANDALONE_SCORE_PDF): ScoreImagePlacement[] {
  const { rasterWidth, rasterHeight, contentMarginPixels, interSheetGapPixels } = layout;
  const contentWidth = rasterWidth - contentMarginPixels * 2;
  const contentHeight = rasterHeight - contentMarginPixels * 2;

  if (imageSizes.length === 0) {
    return [];
  }

  const widthFit = imageSizes.map((size) => fitToContentWidth(size, contentWidth));
  const totalGap = interSheetGapPixels * Math.max(0, imageSizes.length - 1);
  const totalHeight = widthFit.reduce((sum, size) => sum + size.height, 0) + totalGap;
  const compression = totalHeight > contentHeight
    ? Math.max(1, contentHeight - totalGap) / Math.max(1, totalHeight - totalGap)
    : 1;
  const renderedHeight = widthFit.reduce((sum, size) => sum + size.height * compression, 0);
  const groupHeight = renderedHeight + totalGap;

  const placements: ScoreImagePlacement[] = [];
  let y = contentMarginPixels;

  for (const size of widthFit) {
    const width = size.width * compression;
    const height = size.height * compression;
    placements.push({
      x: contentMarginPixels + (contentWidth - width) / 2,
      y,
      width,
      height
    });
    y += height + interSheetGapPixels;
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
