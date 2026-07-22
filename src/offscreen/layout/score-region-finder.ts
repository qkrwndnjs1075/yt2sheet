import { clamp } from "../../shared/geometry";
import type { ScoreRegion } from "../../shared/layout-types";
import type { PreprocessedFrame } from "./preprocessed-frame";
import { toOriginalRect } from "./preprocessed-frame";

const MIN_LINE_SCORE = 0.06;
const MIN_REGION_HEIGHT = 16;

export class ScoreRegionFinder {
  find(frame: PreprocessedFrame): ScoreRegion[] {
    const bands: Array<{ start: number; end: number; lineRows: number; darkPixels: number }> = [];
    let current: { start: number; end: number; lineRows: number; darkPixels: number } | null = null;
    const mergeGap = Math.max(12, Math.round(frame.height * 0.025));

    for (let y = 0; y < frame.height; y += 1) {
      const score = frame.rowLineScores[y];

      if (score >= MIN_LINE_SCORE) {
        if (!current || y - current.end > mergeGap) {
          if (current) {
            bands.push(current);
          }
          current = { start: y, end: y, lineRows: 0, darkPixels: 0 };
        }

        current.end = y;
        current.lineRows += 1;
        current.darkPixels += frame.rowDarkCounts[y];
      } else if (current && y - current.end > mergeGap) {
        bands.push(current);
        current = null;
      }
    }

    if (current) {
      bands.push(current);
    }

    return bands
      .map((band, index) => this.toRegion(frame, band, index))
      .filter((region) => region.rect.height >= MIN_REGION_HEIGHT && region.confidence >= 0.3)
      .slice(0, 8);
  }

  private toRegion(
    frame: PreprocessedFrame,
    band: { start: number; end: number; lineRows: number; darkPixels: number },
    index: number
  ): ScoreRegion {
    const padding = Math.max(8, Math.round((band.end - band.start + 1) * 0.45));
    const y = Math.max(0, band.start - padding);
    const bottom = Math.min(frame.height, band.end + padding);
    const height = Math.max(1, bottom - y);
    const rect = toOriginalRect(frame, { x: 0, y, width: frame.width, height });
    const horizontalLineDensity = clamp(band.lineRows / Math.max(1, height), 0, 1);
    const darkPixelDensity = clamp(band.darkPixels / Math.max(1, band.lineRows * frame.width), 0, 1);
    const aspectRatioScore = clamp((rect.width / Math.max(1, rect.height)) / 8, 0, 1);
    const repeatedPatternScore = clamp(band.lineRows / 6, 0, 1);
    const confidence = clamp(
      0.35 * horizontalLineDensity +
        0.25 * repeatedPatternScore +
        0.2 * aspectRatioScore +
        0.2 * clamp(darkPixelDensity * 4, 0, 1),
      0,
      1
    );

    return {
      id: `region_${index + 1}`,
      rect,
      confidence,
      reason: {
        horizontalLineDensity,
        darkPixelDensity,
        aspectRatioScore,
        repeatedPatternScore
      }
    };
  }
}
