import type { NormalizedScoreImage } from "../../shared/fingerprint-types";
import { clamp } from "../../shared/geometry";

export class QualityEvaluator {
  score(image: NormalizedScoreImage): number {
    const contrast = standardDeviation(image.pixels) / 128;
    const sharpness = edgeEnergy(image);
    const ink = inkDensity(image);
    return clamp(0.45 * contrast + 0.4 * sharpness + 0.15 * scoreInkDensity(ink), 0, 1);
  }
}

export type ScoreImageQuality = {
  score: number;
  blurScore: number;
  contrastScore: number;
  cursorPenalty: number;
  marginPenalty: number;
  resolutionScore: number;
};

export class ScoreQualityEvaluator {
  evaluate(image: NormalizedScoreImage): ScoreImageQuality {
    const contrastScore = clamp(standardDeviation(image.pixels) / 128, 0, 1);
    const blurScore = edgeEnergy(image);
    const resolutionScore = clamp(Math.min(image.width / 512, image.height / 160), 0, 1);
    const cursorPenalty = 0;
    const marginPenalty = 0;
    const score = clamp(
      0.35 * contrastScore +
        0.35 * blurScore +
        0.15 * scoreInkDensity(inkDensity(image)) +
        0.15 * resolutionScore -
        cursorPenalty -
        marginPenalty,
      0,
      1
    );

    return {
      score,
      blurScore,
      contrastScore,
      cursorPenalty,
      marginPenalty,
      resolutionScore
    };
  }
}

function standardDeviation(values: Uint8ClampedArray): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length);
  return Math.sqrt(variance);
}

function edgeEnergy(image: NormalizedScoreImage): number {
  let sum = 0;
  let count = 0;

  for (let y = 1; y < image.height; y += 1) {
    for (let x = 1; x < image.width; x += 1) {
      const current = image.pixels[y * image.width + x];
      const left = image.pixels[y * image.width + x - 1];
      const up = image.pixels[(y - 1) * image.width + x];
      sum += Math.abs(current - left) + Math.abs(current - up);
      count += 2;
    }
  }

  return clamp(sum / Math.max(1, count) / 64, 0, 1);
}

function inkDensity(image: NormalizedScoreImage): number {
  let dark = 0;
  for (const pixel of image.pixels) {
    if (pixel < 150) {
      dark += 1;
    }
  }
  return dark / Math.max(1, image.pixels.length);
}

function scoreInkDensity(ink: number): number {
  return clamp(1 - Math.abs(ink - 0.16) / 0.16, 0, 1);
}
