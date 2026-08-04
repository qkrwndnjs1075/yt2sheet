const BOOTSTRAP_RESAMPLES = 10_000;
const BOUNDARY_WINDOW_MS = 500;
const REQUIRED_TAGS = ["static", "cursor", "scroll", "hard-turn", "fade", "compression", "no-score"] as const;

export type RecallMetric = {
  readonly numerator: number;
  readonly denominator: number;
  readonly ratio: number | null;
};

export type BenchmarkState = {
  readonly stateId: string;
  readonly startMs: number;
  readonly endMs: number;
};

export type BenchmarkBoundary = { readonly timestampMs: number };

export type AssetMetricValue = {
  readonly assetId: string;
  readonly sourceGroupId: string;
  readonly value: number | null;
};

export type BootstrapInterval = {
  readonly replicateCount: number;
  readonly lower95: number | null;
  readonly upper95: number | null;
};

export type BenchmarkGroupEligibility = {
  readonly sourceGroupId: string;
  readonly split: "smoke" | "calibration" | "test";
  readonly approved: boolean;
  readonly classTags: readonly string[];
};

export type PromotionInput = {
  readonly claimTier: "mechanics-only" | "external-gated";
  readonly groups: readonly BenchmarkGroupEligibility[];
  readonly calibrationTunedDuringRun: boolean;
  readonly everyCaseWithinBudget: boolean;
  readonly rightsAndHashesValid?: boolean;
  readonly sourceGroupsIsolated?: boolean;
  readonly allCasesExecuted?: boolean;
  readonly artifactsComplete?: boolean;
  readonly oracleMatches?: boolean;
  readonly structuredPrecision?: number | null;
  readonly fallbackRecall?: number | null;
  readonly falseHardBlocks?: number | null;
  readonly finalPageValidation?: number | null;
  readonly bootstrap: {
    readonly stateRecall: BootstrapInterval;
    readonly boundaryRecall: BootstrapInterval;
    readonly candidateDelta: BootstrapInterval;
  };
};

export type PromotionResult = {
  readonly exitCode: 0 | 4;
  readonly eligible: boolean;
  readonly promotionPassed: boolean;
  readonly qualityClaimsAllowed: boolean;
  readonly gateFailures: readonly string[];
};

export function computeStructuredPrecision(correct: number, predicted: number): number | null {
  if (!Number.isInteger(correct) || !Number.isInteger(predicted) || correct < 0 || predicted < 0 || correct > predicted) {
    throw new RangeError("Structured precision counts must be ordered nonnegative integers.");
  }
  return predicted === 0 ? null : correct / predicted;
}

export function computeUniqueStateRecall(timestampsMs: readonly number[], states: readonly BenchmarkState[]): RecallMetric {
  const numerator = states.filter((state) => timestampsMs.some((timestamp) => timestamp >= state.startMs && timestamp < state.endMs)).length;
  return { numerator, denominator: states.length, ratio: states.length === 0 ? null : numerator / states.length };
}

export function computeBoundaryRecall(
  timestampsMs: readonly number[],
  boundaries: readonly BenchmarkBoundary[],
  windowMs = BOUNDARY_WINDOW_MS
): RecallMetric {
  const pairs = boundaries.flatMap((boundary, boundaryIndex) => timestampsMs.map((timestampMs, candidateIndex) => ({
    boundaryIndex, candidateIndex, boundaryMs: boundary.timestampMs, candidateMs: timestampMs,
    distanceMs: Math.abs(boundary.timestampMs - timestampMs)
  }))).filter((pair) => pair.distanceMs <= windowMs).sort((left, right) =>
    left.distanceMs - right.distanceMs || left.boundaryMs - right.boundaryMs || left.candidateMs - right.candidateMs
  );
  const matchedBoundaries = new Set<number>();
  const matchedCandidates = new Set<number>();
  for (const pair of pairs) {
    if (!matchedBoundaries.has(pair.boundaryIndex) && !matchedCandidates.has(pair.candidateIndex)) {
      matchedBoundaries.add(pair.boundaryIndex);
      matchedCandidates.add(pair.candidateIndex);
    }
  }
  const denominator = boundaries.length;
  return { numerator: matchedBoundaries.size, denominator, ratio: denominator === 0 ? null : matchedBoundaries.size / denominator };
}

export function aggregateAssetValuesBySourceGroup(values: readonly AssetMetricValue[]): {
  readonly groups: readonly { readonly sourceGroupId: string; readonly value: number }[];
  readonly macro: number | null;
} {
  const grouped = new Map<string, number[]>();
  for (const entry of values) {
    if (entry.value === null) continue;
    const groupValues = grouped.get(entry.sourceGroupId) ?? [];
    groupValues.push(entry.value);
    grouped.set(entry.sourceGroupId, groupValues);
  }
  const groups = [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([sourceGroupId, groupValues]) => ({
    sourceGroupId,
    value: groupValues.reduce((sum, value) => sum + value, 0) / groupValues.length
  }));
  return {
    groups,
    macro: groups.length === 0 ? null : groups.reduce((sum, group) => sum + group.value, 0) / groups.length
  };
}

export function createMulberry32(seed: number): { readonly nextUint32: () => number; readonly next: () => number } {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) throw new RangeError("Seed must be an unsigned 32-bit integer.");
  let state = seed >>> 0;
  const nextUint32 = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1) >>> 0;
    value = (value ^ (value + Math.imul(value ^ (value >>> 7), value | 61))) >>> 0;
    return (value ^ (value >>> 14)) >>> 0;
  };
  return { nextUint32, next: () => nextUint32() / 4_294_967_296 };
}

function percentileR7(sorted: readonly number[], probability: number): number {
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower];
  const upperValue = sorted[upper];
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

export function bootstrapPairedGroupDeltas(values: readonly (number | null)[], seed: number): BootstrapInterval {
  if (values.length === 0 || values.every((value) => value === null)) return { replicateCount: 0, lower95: null, upper95: null };
  const random = createMulberry32(seed);
  const replicates: number[] = [];
  for (let replicate = 0; replicate < BOOTSTRAP_RESAMPLES; replicate += 1) {
    let sum = 0;
    let count = 0;
    for (let sample = 0; sample < values.length; sample += 1) {
      const value = values[Math.floor(random.next() * values.length)];
      if (value !== null) {
        sum += value;
        count += 1;
      }
    }
    if (count > 0) replicates.push(sum / count);
  }
  replicates.sort((left, right) => left - right);
  return {
    replicateCount: replicates.length,
    lower95: replicates.length === 0 ? null : percentileR7(replicates, 0.025),
    upper95: replicates.length === 0 ? null : percentileR7(replicates, 0.975)
  };
}

function isEligible(groups: readonly BenchmarkGroupEligibility[], calibratedDuringRun: boolean): boolean {
  if (calibratedDuringRun) return false;
  const byId = new Map<string, { approved: boolean; splits: Set<string>; tags: Set<string> }>();
  for (const group of groups) {
    const aggregate = byId.get(group.sourceGroupId) ?? { approved: true, splits: new Set<string>(), tags: new Set<string>() };
    aggregate.approved = aggregate.approved && group.approved;
    aggregate.splits.add(group.split);
    for (const tag of group.classTags) aggregate.tags.add(tag);
    byId.set(group.sourceGroupId, aggregate);
  }
  const approved = [...byId.values()].filter((group) => group.approved && group.splits.size === 1);
  const calibration = approved.filter((group) => group.splits.has("calibration"));
  const test = approved.filter((group) => group.splits.has("test"));
  return approved.length >= 30 && calibration.length >= 10 && test.length >= 20
    && [...byId.values()].every((group) => group.splits.size === 1)
    && REQUIRED_TAGS.every((tag) => test.filter((group) => group.tags.has(tag)).length >= 5);
}

export function evaluatePromotion(input: PromotionInput): PromotionResult {
  if (input.claimTier === "mechanics-only") {
    return { exitCode: 0, eligible: false, promotionPassed: false, qualityClaimsAllowed: false, gateFailures: [] };
  }
  const eligible = isEligible(input.groups, input.calibrationTunedDuringRun);
  const gateFailures: string[] = [];
  if (input.rightsAndHashesValid === false) gateFailures.push("rights-hash-integrity");
  if (input.sourceGroupsIsolated === false) gateFailures.push("source-group-isolation");
  if (input.allCasesExecuted === false) gateFailures.push("all-cases-executed");
  if (input.artifactsComplete === false) gateFailures.push("artifact-integrity");
  if (input.oracleMatches === false) gateFailures.push("oracle-exactness");
  if (input.structuredPrecision !== undefined && input.structuredPrecision !== 1) gateFailures.push("structured-precision");
  if (input.fallbackRecall !== undefined && input.fallbackRecall !== 1) gateFailures.push("fallback-recall");
  if (input.falseHardBlocks !== undefined && input.falseHardBlocks !== 0) gateFailures.push("false-hard-blocks");
  if (input.finalPageValidation !== undefined && input.finalPageValidation !== 1) gateFailures.push("final-page-validation");
  if (input.calibrationTunedDuringRun) gateFailures.push("calibration-frozen");
  if (input.bootstrap.stateRecall.lower95 === null || input.bootstrap.stateRecall.lower95 < 0) gateFailures.push("state-recall-lower95");
  if (input.bootstrap.boundaryRecall.lower95 === null || input.bootstrap.boundaryRecall.lower95 < 0) gateFailures.push("boundary-recall-lower95");
  if (input.bootstrap.candidateDelta.upper95 === null || input.bootstrap.candidateDelta.upper95 > 0) gateFailures.push("candidate-delta-upper95");
  if (!input.everyCaseWithinBudget) gateFailures.push("case-budget");
  const promotionPassed = eligible && gateFailures.length === 0;
  return { exitCode: promotionPassed ? 0 : 4, eligible, promotionPassed, qualityClaimsAllowed: promotionPassed, gateFailures };
}
