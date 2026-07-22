import type { DebugUniqueScore } from "./messages";

export type ScoreOccurrenceOrderOptions = {
  readonly occurrenceOrder?: readonly string[];
  readonly scoreOrder?: readonly string[];
};

export type ScoreOccurrence = DebugUniqueScore & {
  readonly occurrenceId: string;
  readonly occurrenceOrder: number;
  readonly repeatIndex: number;
  readonly repeatCount: number;
  readonly previousOccurrenceId?: string;
  readonly nextOccurrenceId?: string;
};

export function orderScoreOccurrences(
  scores: readonly DebugUniqueScore[],
  options: ScoreOccurrenceOrderOptions = {}
): ScoreOccurrence[] {
  const occurrences = createScoreOccurrences(scores);
  if (options.occurrenceOrder !== undefined) {
    return orderByOccurrenceIds(occurrences, options.occurrenceOrder);
  }
  if (options.scoreOrder !== undefined && !hasOccurrenceMetadata(scores)) {
    return orderByLegacyClusterIds(scores, options.scoreOrder);
  }
  return occurrences;
}

export function createScoreOccurrences(scores: readonly DebugUniqueScore[]): ScoreOccurrence[] {
  const sortedScores = sortScoresForOccurrenceScan(scores);
  const occurrenceHeads: DebugUniqueScore[] = [];
  let previousClusterId: string | undefined;

  for (const score of sortedScores) {
    if (score.clusterId !== previousClusterId) {
      occurrenceHeads.push(score);
      previousClusterId = score.clusterId;
    }
  }

  return attachOccurrenceMetadata(occurrenceHeads);
}

function sortScoresForOccurrenceScan(scores: readonly DebugUniqueScore[]): DebugUniqueScore[] {
  return [...scores].sort(compareScorePosition);
}

function compareScorePosition(left: DebugUniqueScore, right: DebugUniqueScore): number {
  const leftOccurrenceOrder = left.occurrenceOrder;
  const rightOccurrenceOrder = right.occurrenceOrder;
  if (leftOccurrenceOrder !== undefined || rightOccurrenceOrder !== undefined) {
    return compareOptionalNumber(leftOccurrenceOrder, rightOccurrenceOrder) || compareFallbackPosition(left, right);
  }
  return compareFallbackPosition(left, right);
}

function compareFallbackPosition(left: DebugUniqueScore, right: DebugUniqueScore): number {
  return left.source.firstSeenSec - right.source.firstSeenSec || left.order - right.order;
}

function compareOptionalNumber(left: number | undefined, right: number | undefined): number {
  if (left === undefined && right === undefined) {
    return 0;
  }
  if (left === undefined) {
    return 1;
  }
  if (right === undefined) {
    return -1;
  }
  return left - right;
}

function attachOccurrenceMetadata(scores: readonly DebugUniqueScore[]): ScoreOccurrence[] {
  const repeatCounts = countClusterRepeats(scores);
  const seenByCluster = new Map<string, number>();
  const occurrenceIds = scores.map((score, index) => score.occurrenceId ?? stableOccurrenceId(score, index + 1));

  return scores.map((score, index) => {
    const currentRepeatCount = seenByCluster.get(score.clusterId) ?? 0;
    const repeatIndex = score.repeatIndex ?? currentRepeatCount + 1;
    seenByCluster.set(score.clusterId, repeatIndex);

    return {
      ...score,
      occurrenceId: occurrenceIds[index] ?? stableOccurrenceId(score, index + 1),
      occurrenceOrder: score.occurrenceOrder ?? index + 1,
      repeatIndex,
      repeatCount: score.repeatCount ?? repeatCounts.get(score.clusterId) ?? 1,
      previousOccurrenceId: score.previousOccurrenceId ?? occurrenceIds[index - 1],
      nextOccurrenceId: score.nextOccurrenceId ?? occurrenceIds[index + 1]
    };
  });
}

function countClusterRepeats(scores: readonly DebugUniqueScore[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const score of scores) {
    counts.set(score.clusterId, (counts.get(score.clusterId) ?? 0) + 1);
  }
  return counts;
}

function stableOccurrenceId(score: DebugUniqueScore, occurrenceOrder: number): string {
  return `${score.sessionId}:${score.clusterId}:${occurrenceOrder}`;
}

function orderByOccurrenceIds(
  occurrences: readonly ScoreOccurrence[],
  occurrenceOrder: readonly string[]
): ScoreOccurrence[] {
  const byOccurrenceId = new Map(occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
  const ordered: ScoreOccurrence[] = [];
  const usedOccurrenceIds = new Set<string>();

  for (const occurrenceId of occurrenceOrder) {
    const occurrence = byOccurrenceId.get(occurrenceId);
    if (occurrence !== undefined && !usedOccurrenceIds.has(occurrenceId)) {
      ordered.push(occurrence);
      usedOccurrenceIds.add(occurrenceId);
    }
  }

  return ordered;
}

function orderByLegacyClusterIds(scores: readonly DebugUniqueScore[], scoreOrder: readonly string[]): ScoreOccurrence[] {
  const legacyOccurrences = attachOccurrenceMetadata(uniqueScoresByCluster(scores));
  const byClusterId = new Map(legacyOccurrences.map((occurrence) => [occurrence.clusterId, occurrence]));
  const ordered: ScoreOccurrence[] = [];
  const usedClusterIds = new Set<string>();

  for (const clusterId of scoreOrder) {
    const occurrence = byClusterId.get(clusterId);
    if (occurrence !== undefined && !usedClusterIds.has(clusterId)) {
      ordered.push(occurrence);
      usedClusterIds.add(clusterId);
    }
  }

  return ordered;
}

function uniqueScoresByCluster(scores: readonly DebugUniqueScore[]): DebugUniqueScore[] {
  const sortedScores = sortScoresForOccurrenceScan(scores);
  const byClusterId = new Map<string, DebugUniqueScore>();
  for (const score of sortedScores) {
    if (!byClusterId.has(score.clusterId)) {
      byClusterId.set(score.clusterId, score);
    }
  }
  return [...byClusterId.values()];
}

function hasOccurrenceMetadata(scores: readonly DebugUniqueScore[]): boolean {
  return scores.some((score) => score.occurrenceId !== undefined || score.occurrenceOrder !== undefined);
}
