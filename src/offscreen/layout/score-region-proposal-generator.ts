import { clamp } from "../../shared/geometry";
import type { Rect, ScoreRegion, ScoreRegionProposal } from "../../shared/layout-types";
import type { PreprocessedFrame } from "./preprocessed-frame";
import { toOriginalRect } from "./preprocessed-frame";

const WEAK_PROPOSAL_THRESHOLD = 0.35;
const PROMOTION_THRESHOLD = 0.65;
const REJECT_THRESHOLD = 0.2;

type Band = {
  start: number;
  end: number;
  rows: number;
  darkPixels: number;
  brightPixels: number;
  lineScoreSum: number;
  edgeScoreSum: number;
};

export class ScoreRegionProposalGenerator {
  generate(frame: PreprocessedFrame): ScoreRegionProposal[] {
    const proposals = [
      ...this.generateFromRows(frame, "horizontal_line", (y) => frame.rowLineScores[y] >= 0.035),
      ...this.generateFromRows(frame, "bright_panel", (y) => frame.rowBrightCounts[y] / frame.width >= 0.34),
      ...this.generateFromRows(frame, "edge_density", (y) => frame.rowEdgeScores[y] >= 0.035)
    ];

    return this.dedupe(proposals).map((proposal, index) => ({ ...proposal, id: `proposal_${index + 1}` }));
  }

  toScoreRegion(proposal: ScoreRegionProposal, index: number): ScoreRegion {
    return {
      id: `region_${index + 1}`,
      rect: proposal.rect,
      confidence: proposal.scores.finalScore,
      reason: {
        horizontalLineDensity: proposal.scores.horizontalLineScore,
        darkPixelDensity: proposal.scores.contrastScore,
        aspectRatioScore: proposal.scores.aspectRatioScore,
        repeatedPatternScore: proposal.scores.edgeDensityScore
      }
    };
  }

  private generateFromRows(
    frame: PreprocessedFrame,
    source: ScoreRegionProposal["source"],
    isCandidateRow: (y: number) => boolean
  ): ScoreRegionProposal[] {
    const bands: Band[] = [];
    let current: Band | null = null;
    const mergeGap = Math.max(10, Math.round(frame.height * 0.025));

    for (let y = 0; y < frame.height; y += 1) {
      if (isCandidateRow(y)) {
        if (!current || y - current.end > mergeGap) {
          if (current) {
            bands.push(current);
          }
          current = { start: y, end: y, rows: 0, darkPixels: 0, brightPixels: 0, lineScoreSum: 0, edgeScoreSum: 0 };
        }

        current.end = y;
        current.rows += 1;
        current.darkPixels += frame.rowDarkCounts[y];
        current.brightPixels += frame.rowBrightCounts[y];
        current.lineScoreSum += frame.rowLineScores[y];
        current.edgeScoreSum += frame.rowEdgeScores[y];
      } else if (current && y - current.end > mergeGap) {
        bands.push(current);
        current = null;
      }
    }

    if (current) {
      bands.push(current);
    }

    return bands
      .map((band, index) => this.toProposal(frame, band, source, index))
      .filter((proposal) => proposal.scores.finalScore >= REJECT_THRESHOLD)
      .slice(0, 12);
  }

  private toProposal(frame: PreprocessedFrame, band: Band, source: ScoreRegionProposal["source"], index: number): ScoreRegionProposal {
    const padding = Math.max(8, Math.round((band.end - band.start + 1) * 0.55));
    const y = Math.max(0, band.start - padding);
    const bottom = Math.min(frame.height, band.end + padding);
    const height = Math.max(1, bottom - y);
    const rect = toOriginalRect(frame, { x: 0, y, width: frame.width, height });
    const analysisRect = { x: 0, y, width: frame.width, height };
    const scores = this.scoreBand(frame, band, analysisRect, source);

    return {
      id: `${source}_${index + 1}`,
      rect,
      source,
      ruleScores: {
        horizontalLineScore: scores.horizontalLineScore,
        brightPanelScore: scores.brightPanelScore,
        edgeDensityScore: scores.edgeDensityScore,
        aspectRatioScore: scores.aspectRatioScore,
        contrastScore: scores.contrastScore,
        finalRuleScore: scores.finalScore
      },
      finalScores: {
        ruleScore: scores.finalScore,
        temporalStabilityScore: 0,
        finalScore: scores.finalScore
      },
      scores,
      status: scores.finalScore >= PROMOTION_THRESHOLD ? "promoted" : scores.finalScore >= WEAK_PROPOSAL_THRESHOLD ? "weak" : "rejected"
    };
  }

  private scoreBand(frame: PreprocessedFrame, band: Band, rect: Rect, source: ScoreRegionProposal["source"]): ScoreRegionProposal["scores"] {
    const rows = Math.max(1, band.rows);
    const horizontalLineScore = clamp((band.lineScoreSum / rows) / 0.16, 0, 1);
    const brightPanelScore = clamp((band.brightPixels / Math.max(1, rows * frame.width) - 0.32) / 0.48, 0, 1);
    const edgeDensityScore = clamp((band.edgeScoreSum / rows) / 0.11, 0, 1);
    const aspectRatioScore = clamp((rect.width / Math.max(1, rect.height)) / 3.8, 0, 1);
    const contrastScore = clamp((band.darkPixels / Math.max(1, rows * frame.width)) / 0.18, 0, 1);
    const sourceBoost = source === "horizontal_line" ? 0.06 : source === "bright_panel" ? 0.04 : 0.02;
    const finalScore = clamp(
      0.3 * horizontalLineScore +
        0.24 * brightPanelScore +
        0.2 * edgeDensityScore +
        0.16 * aspectRatioScore +
        0.1 * contrastScore +
        sourceBoost,
      0,
      1
    );

    return {
      horizontalLineScore,
      brightPanelScore,
      edgeDensityScore,
      aspectRatioScore,
      contrastScore,
      temporalStabilityScore: 0,
      finalScore
    };
  }

  private dedupe(proposals: ScoreRegionProposal[]): ScoreRegionProposal[] {
    const sorted = [...proposals].sort((a, b) => b.scores.finalScore - a.scores.finalScore);
    const kept: ScoreRegionProposal[] = [];

    for (const proposal of sorted) {
      if (!kept.some((existing) => verticalOverlapRatio(existing.rect, proposal.rect) > 0.72)) {
        kept.push(proposal);
      }
    }

    return kept.sort((a, b) => a.rect.y - b.rect.y);
  }
}

export function isWeakProposal(proposal: ScoreRegionProposal): boolean {
  return proposal.status !== "rejected" && proposal.scores.finalScore >= WEAK_PROPOSAL_THRESHOLD;
}

function verticalOverlapRatio(a: Rect, b: Rect): number {
  const top = Math.max(a.y, b.y);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return Math.max(0, bottom - top) / Math.max(1, Math.min(a.height, b.height));
}
