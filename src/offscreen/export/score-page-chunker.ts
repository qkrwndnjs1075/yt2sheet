import type { CapturedScoreSystem } from "../../shared/capture-types";
import type { ScorePage } from "../../shared/page-types";
import { SCORE_IDENTITY_CONFIG } from "../../shared/score-identity-config";
import { orderScoreOccurrences } from "../../shared/score-occurrences";
import { packScorePages } from "../../shared/score-page-layout";

export type ScorePageChunkOptions = {
  readonly occurrenceOrder?: readonly string[];
  readonly scoreOrder?: readonly string[];
};

export class ScorePageChunker {
  chunk(scores: CapturedScoreSystem[], options: ScorePageChunkOptions = {}): CapturedScoreSystem[][] {
    const uniqueScores = this.shouldUseOccurrenceOrdering(scores, options)
      ? this.orderCapturedOccurrences(scores, options)
      : Array.isArray(options.scoreOrder)
        ? this.orderByReviewedClusterIds(this.uniqueByClusterId(scores), options.scoreOrder)
      : this.sortByFirstSeen(this.uniqueByClusterId(scores));

    return packScorePages(uniqueScores);
  }

  createPages(sessionId: string, scores: CapturedScoreSystem[], options: ScorePageChunkOptions = {}): ScorePage[] {
    return this.chunk(scores, options).map((systems, pageIndex) => ({
      id: `score_page_${pageIndex + 1}`,
      sessionId,
      pageIndex,
      systems,
      width: SCORE_IDENTITY_CONFIG.page.pageWidth,
      height: SCORE_IDENTITY_CONFIG.page.pageHeight
    }));
  }

  private shouldUseOccurrenceOrdering(scores: CapturedScoreSystem[], options: ScorePageChunkOptions): boolean {
    return Array.isArray(options.occurrenceOrder) || scores.some((score) => score.occurrenceId !== undefined || score.occurrenceOrder !== undefined);
  }

  private orderCapturedOccurrences(scores: CapturedScoreSystem[], options: ScorePageChunkOptions): CapturedScoreSystem[] {
    const byScoreId = new Map(scores.map((score) => [score.id, score]));
    return orderScoreOccurrences(scores, options).flatMap((occurrence) => {
      const score = byScoreId.get(occurrence.id);
      return score === undefined ? [] : [score];
    });
  }

  private uniqueByClusterId(scores: CapturedScoreSystem[]): CapturedScoreSystem[] {
    const map = new Map<string, CapturedScoreSystem>();
    for (const score of scores) {
      if (!map.has(score.clusterId)) {
        map.set(score.clusterId, score);
      }
    }
    return [...map.values()];
  }

  private orderByReviewedClusterIds(scores: CapturedScoreSystem[], scoreOrder: readonly string[]): CapturedScoreSystem[] {
    const byClusterId = new Map(scores.map((score) => [score.clusterId, score]));
    const ordered: CapturedScoreSystem[] = [];
    const seen = new Set<string>();

    for (const clusterId of scoreOrder) {
      const score = byClusterId.get(clusterId);
      if (!score || seen.has(clusterId)) {
        continue;
      }

      ordered.push(score);
      seen.add(clusterId);
    }

    return ordered;
  }

  private sortByFirstSeen(scores: CapturedScoreSystem[]): CapturedScoreSystem[] {
    return [...scores].sort((a, b) => {
      const timeDiff = a.source.firstSeenSec - b.source.firstSeenSec;
      return timeDiff !== 0 ? timeDiff : a.order - b.order;
    });
  }
}
