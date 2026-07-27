import { clamp, median, scoreFromDistance } from "../../shared/geometry";
import type { Rect, ScoreRegion, StaffCandidate } from "../../shared/layout-types";
import type { PreprocessedFrame } from "./preprocessed-frame";
import { toAnalysisRect, toOriginalRect } from "./preprocessed-frame";

type LinePeak = {
  y: number;
  xMin: number;
  xMax: number;
  strength: number;
};

type CandidateDraft = StaffCandidate & {
  analysisRect: Rect;
};

const MIN_LINE_SCORE = 0.06;
const DENSE_NOTATION_LINE_SCORE = 0.3;
const MIN_LINE_WIDTH_RATIO = 0.12;

export class StaffCandidateDetector {
  find(frame: PreprocessedFrame, regions: ScoreRegion[]): StaffCandidate[] {
    const searchRegions = regions.length > 0 ? regions : [fullFrameRegion(frame)];
    const drafts = searchRegions.flatMap((region) => this.findInRegion(frame, region));
    const deduped = this.dedupe(drafts);

    return deduped.map(({ analysisRect: _analysisRect, ...candidate }) => candidate);
  }

  private findInRegion(frame: PreprocessedFrame, region: ScoreRegion): CandidateDraft[] {
    const rect = toAnalysisRect(frame, region.rect);
    const top = Math.max(0, Math.floor(rect.y));
    const bottom = Math.min(frame.height - 1, Math.ceil(rect.y + rect.height));
    const drafts = this.findCandidates(frame, this.findLinePeaks(frame, top, bottom, MIN_LINE_SCORE));

    if (drafts.length > 0) {
      return drafts;
    }

    return this.findCandidates(frame, this.findLinePeaks(frame, top, bottom, DENSE_NOTATION_LINE_SCORE));
  }

  private findCandidates(frame: PreprocessedFrame, peaks: LinePeak[]): CandidateDraft[] {
    const drafts: CandidateDraft[] = [];

    for (const lineCount of [6, 5] as const) {
      for (let index = 0; index <= peaks.length - lineCount; index += 1) {
        const group = peaks.slice(index, index + lineCount);
        const draft = this.buildCandidate(frame, group, lineCount, drafts.length + 1);

        if (draft && draft.confidence >= 0.45) {
          drafts.push(draft);
        }
      }
    }

    return drafts;
  }

  private findLinePeaks(frame: PreprocessedFrame, top: number, bottom: number, minimumScore: number): LinePeak[] {
    const peaks: LinePeak[] = [];
    let start: number | null = null;
    let strengthSum = 0;
    let ySum = 0;

    for (let y = top; y <= bottom; y += 1) {
      const score = frame.rowLineScores[y];

      if (score >= minimumScore) {
        start ??= y;
        strengthSum += score;
        ySum += y * score;
        continue;
      }

      if (start !== null) {
        peaks.push(this.buildPeak(frame, start, y - 1, strengthSum, ySum));
        start = null;
        strengthSum = 0;
        ySum = 0;
      }
    }

    if (start !== null) {
      peaks.push(this.buildPeak(frame, start, bottom, strengthSum, ySum));
    }

    return peaks.filter((peak) => (peak.xMax - peak.xMin + 1) / frame.width >= MIN_LINE_WIDTH_RATIO);
  }

  private buildPeak(frame: PreprocessedFrame, start: number, end: number, strengthSum: number, ySum: number): LinePeak {
    const y = strengthSum === 0 ? (start + end) / 2 : ySum / strengthSum;
    let xMin = frame.width;
    let xMax = 0;

    for (let row = start; row <= end; row += 1) {
      for (let x = 0; x < frame.width; x += 1) {
        if (frame.binary[row * frame.width + x] === 1) {
          xMin = Math.min(xMin, x);
          xMax = Math.max(xMax, x);
        }
      }
    }

    return {
      y,
      xMin: xMin === frame.width ? 0 : xMin,
      xMax,
      strength: strengthSum / Math.max(1, end - start + 1)
    };
  }

  private buildCandidate(frame: PreprocessedFrame, peaks: LinePeak[], lineCount: 5 | 6, idIndex: number): CandidateDraft | null {
    const gaps = peaks.slice(1).map((peak, index) => peak.y - peaks[index].y);
    const estimatedGap = median(gaps);

    if (!estimatedGap || estimatedGap < 3 || estimatedGap > Math.max(24, frame.height * 0.08)) {
      return null;
    }

    const maxGapDelta = Math.max(...gaps.map((gap) => Math.abs(gap - estimatedGap)));
    const lineRegularity = scoreFromDistance(maxGapDelta, estimatedGap * 0.32);
    const xMin = Math.min(...peaks.map((peak) => peak.xMin));
    const xMax = Math.max(...peaks.map((peak) => peak.xMax));
    const widths = peaks.map((peak) => peak.xMax - peak.xMin + 1);
    const widthMedian = median(widths) ?? 1;
    const widthConsistency = scoreFromDistance(Math.max(...widths.map((width) => Math.abs(width - widthMedian))), widthMedian * 0.18);
    const lineLengthScore = clamp(widthMedian / frame.width / 0.65, 0, 1);
    const horizontalLineStrength = clamp(peaks.reduce((sum, peak) => sum + peak.strength, 0) / peaks.length / 0.55, 0, 1);
    const confidence = clamp(
      0.35 * lineRegularity + 0.25 * lineLengthScore + 0.2 * widthConsistency + 0.2 * horizontalLineStrength,
      0,
      1
    );
    const padding = Math.max(2, estimatedGap * 0.6);
    const top = Math.max(0, peaks[0].y - padding);
    const bottom = Math.min(frame.height, peaks[peaks.length - 1].y + padding);
    const analysisRect = {
      x: xMin,
      y: top,
      width: Math.max(1, xMax - xMin + 1),
      height: Math.max(1, bottom - top)
    };
    const rect = toOriginalRect(frame, analysisRect);

    return {
      id: `staff_${idIndex}`,
      rect,
      analysisRect,
      lineCount,
      kind: lineCount === 6 ? "tab_staff" : "standard_staff",
      metrics: {
        estimatedLineGap: estimatedGap / frame.analysisScale,
        horizontalLineStrength,
        lineRegularity,
        widthConsistency
      },
      confidence
    };
  }

  private dedupe(candidates: CandidateDraft[]): CandidateDraft[] {
    const sorted = [...candidates].sort((a, b) => b.confidence - a.confidence || Number(b.lineCount) - Number(a.lineCount));
    const kept: CandidateDraft[] = [];

    for (const candidate of sorted) {
      const overlaps = kept.some((existing) => Math.abs(centerY(existing.rect) - centerY(candidate.rect)) < candidate.metrics.estimatedLineGap * 2);
      if (!overlaps) {
        kept.push(candidate);
      }
    }

    return kept
      .sort((a, b) => a.rect.y - b.rect.y)
      .map((candidate, index) => ({ ...candidate, id: `staff_${index + 1}` }));
  }
}

function fullFrameRegion(frame: PreprocessedFrame): ScoreRegion {
  return {
    id: "region_full",
    rect: { x: 0, y: 0, width: frame.originalWidth, height: frame.originalHeight },
    confidence: 0,
    reason: {
      horizontalLineDensity: 0,
      darkPixelDensity: 0,
      aspectRatioScore: 0,
      repeatedPatternScore: 0
    }
  };
}

function centerY(rect: Rect): number {
  return rect.y + rect.height / 2;
}
