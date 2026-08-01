export const SCORE_EXTRACTION_QUALITY_REPORT_VERSION = "score-extraction-quality-report/1";

export type FrameIdentifier = `frame-${string}`;
export type ScoreIdentifier = `score-${string}`;

export type DuplicateReason = "near-duplicate" | "dominant-ink" | "notation-identity";

export type DuplicateReasonCandidates = {
  readonly nearDuplicate: boolean;
  readonly dominantInk: boolean;
  readonly notationIdentity: boolean;
};

export type NoScoreFrameDisposition = {
  readonly frameId: FrameIdentifier;
  readonly disposition: "no-score";
};

export type AcceptedFrameDisposition = {
  readonly frameId: FrameIdentifier;
  readonly disposition: "accepted";
  readonly scoreId: ScoreIdentifier;
  readonly pageNumber: number;
};

export type DuplicateFrameDisposition = {
  readonly frameId: FrameIdentifier;
  readonly disposition: "duplicate";
  readonly duplicateReason: DuplicateReason;
};

export type FrameDisposition = NoScoreFrameDisposition | AcceptedFrameDisposition | DuplicateFrameDisposition;

export type ScoreExtractionStageDurationsMs = {
  readonly analysis: number;
  readonly deduplication: number;
  readonly pageComposition: number;
  readonly total: number;
};

export type ScoreExtractionQualityReportInput = {
  readonly durationsMs: ScoreExtractionStageDurationsMs;
  readonly frames: readonly FrameDisposition[];
};

export type ScoreExtractionQualityReport = {
  readonly version: typeof SCORE_EXTRACTION_QUALITY_REPORT_VERSION;
  readonly qualityClaimsAllowed: false;
  readonly durationsMs: ScoreExtractionStageDurationsMs;
  readonly frames: readonly FrameDisposition[];
};

export class ScoreQualityReportContractError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = "ScoreQualityReportContractError";
  }
}

export function frameIdentifier(index: number): FrameIdentifier {
  return `frame-${formatOneBasedInteger(index, 6)}`;
}

export function scoreIdentifier(index: number): ScoreIdentifier {
  return `score-${formatOneBasedInteger(index, 4)}`;
}

export function resolveDuplicateReason(candidates: DuplicateReasonCandidates): DuplicateReason {
  if (candidates.nearDuplicate) return "near-duplicate";
  if (candidates.dominantInk) return "dominant-ink";
  if (candidates.notationIdentity) return "notation-identity";
  throw new ScoreQualityReportContractError("duplicate frame requires a duplicate reason");
}

export function createScoreExtractionQualityReport(input: ScoreExtractionQualityReportInput): ScoreExtractionQualityReport {
  const durationsMs = canonicalDurations(input.durationsMs);
  const frames = canonicalFrames(input.frames);
  return {
    version: SCORE_EXTRACTION_QUALITY_REPORT_VERSION,
    qualityClaimsAllowed: false,
    durationsMs,
    frames
  };
}

export function serializeScoreExtractionQualityReport(report: ScoreExtractionQualityReport): string {
  if (report.version !== SCORE_EXTRACTION_QUALITY_REPORT_VERSION) {
    throw new ScoreQualityReportContractError("unsupported score extraction quality report version");
  }
  if (report.qualityClaimsAllowed !== false) {
    throw new ScoreQualityReportContractError("quality claims must be disabled");
  }
  const durationsMs = canonicalDurations(report.durationsMs);
  const frames = canonicalFrames(report.frames);
  return JSON.stringify({
    version: SCORE_EXTRACTION_QUALITY_REPORT_VERSION,
    qualityClaimsAllowed: false,
    durationsMs,
    frames
  });
}

export function deriveScoreQualitySidecarPath(resultPdfPath: string): string {
  return `${resultPdfPath}.quality.json`;
}

function canonicalDurations(durationsMs: ScoreExtractionStageDurationsMs): ScoreExtractionStageDurationsMs {
  assertNonNegativeDuration(durationsMs.analysis, "analysis");
  assertNonNegativeDuration(durationsMs.deduplication, "deduplication");
  assertNonNegativeDuration(durationsMs.pageComposition, "pageComposition");
  assertNonNegativeDuration(durationsMs.total, "total");
  return {
    analysis: durationsMs.analysis,
    deduplication: durationsMs.deduplication,
    pageComposition: durationsMs.pageComposition,
    total: durationsMs.total
  };
}

function canonicalFrames(frames: readonly FrameDisposition[]): readonly FrameDisposition[] {
  let acceptedScoreCount = 0;
  return frames.map((frame, index) => {
    const expectedFrameId = frameIdentifier(index + 1);
    if (frame.frameId !== expectedFrameId) {
      throw new ScoreQualityReportContractError(`expected ${expectedFrameId}`);
    }
    switch (frame.disposition) {
      case "no-score":
        return { frameId: expectedFrameId, disposition: "no-score" };
      case "accepted": {
        acceptedScoreCount += 1;
        const expectedScoreId = scoreIdentifier(acceptedScoreCount);
        if (frame.scoreId !== expectedScoreId) {
          throw new ScoreQualityReportContractError(`expected ${expectedScoreId}`);
        }
        assertOneBasedInteger(frame.pageNumber, "accepted frame page number");
        return {
          frameId: expectedFrameId,
          disposition: "accepted",
          scoreId: expectedScoreId,
          pageNumber: frame.pageNumber
        };
      }
      case "duplicate":
        return {
          frameId: expectedFrameId,
          disposition: "duplicate",
          duplicateReason: canonicalDuplicateReason(frame.duplicateReason)
        };
      default:
        return assertNever(frame);
    }
  });
}

function canonicalDuplicateReason(reason: DuplicateReason): DuplicateReason {
  switch (reason) {
    case "near-duplicate":
      return "near-duplicate";
    case "dominant-ink":
      return "dominant-ink";
    case "notation-identity":
      return "notation-identity";
    default:
      return assertNever(reason);
  }
}

function formatOneBasedInteger(index: number, width: number): string {
  assertOneBasedInteger(index, "identifier index");
  return String(index).padStart(width, "0");
}

function assertOneBasedInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ScoreQualityReportContractError(`${name} must be a 1-based integer`);
  }
}

function assertNonNegativeDuration(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new ScoreQualityReportContractError(`${name} duration must be non-negative`);
  }
}

function assertNever(value: never): never {
  throw new ScoreQualityReportContractError(`unexpected report value: ${String(value)}`);
}
