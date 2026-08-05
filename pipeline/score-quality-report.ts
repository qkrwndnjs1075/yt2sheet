import {
  createScoreReview,
  type ScoreReview,
  type ScoreReviewInput
} from "./score-review-contract";

export const SCORE_EXTRACTION_QUALITY_REPORT_VERSION = "score-extraction-quality-report/2";

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
  readonly generatedAt?: string;
  readonly review?: ScoreReviewInput;
};

export type ScoreExtractionQualityReport = {
  readonly version: typeof SCORE_EXTRACTION_QUALITY_REPORT_VERSION;
  readonly qualityClaimsAllowed: false;
  readonly durationsMs: ScoreExtractionStageDurationsMs;
  readonly frames: readonly FrameDisposition[];
  readonly generatedAt?: string;
  readonly review: ScoreReview;
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
  const review = input.review === undefined ? defaultRasterReview(frames) : createScoreReview(input.review);
  const generatedAt = input.generatedAt === undefined ? undefined : canonicalGeneratedAt(input.generatedAt);
  return {
    version: SCORE_EXTRACTION_QUALITY_REPORT_VERSION,
    qualityClaimsAllowed: false,
    durationsMs,
    frames,
    ...(generatedAt === undefined ? {} : { generatedAt }),
    review
  };
}

export function serializeScoreExtractionQualityReport(report: ScoreExtractionQualityReport): string {
  if (report.version !== SCORE_EXTRACTION_QUALITY_REPORT_VERSION) {
    throw new ScoreQualityReportContractError("unsupported score extraction quality report version");
  }
  if (report.qualityClaimsAllowed !== false) {
    throw new ScoreQualityReportContractError("quality claims must be disabled");
  }
  if (report.review === undefined) {
    throw new ScoreQualityReportContractError("v2 report requires a review outcome");
  }
  const durationsMs = canonicalDurations(report.durationsMs);
  const frames = canonicalFrames(report.frames);
  const generatedAt = report.generatedAt === undefined ? undefined : canonicalGeneratedAt(report.generatedAt);
  const review = canonicalReview(report.review);
  return JSON.stringify({
    version: SCORE_EXTRACTION_QUALITY_REPORT_VERSION,
    qualityClaimsAllowed: false,
    durationsMs,
    frames,
    ...(generatedAt === undefined ? {} : { generatedAt }),
    review
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

function defaultRasterReview(frames: readonly FrameDisposition[]): ScoreReview {
  const pageCount = frames.reduce((highestPage, frame) => frame.disposition === "accepted"
    ? Math.max(highestPage, frame.pageNumber)
    : highestPage, 0);
  return createScoreReview({
    disposition: "raster-fallback",
    rasterSafe: true,
    decisions: [{ pageNumber: null, code: "RASTER_FALLBACK_SELECTED", evidence: { pageCount } }]
  });
}

function canonicalReview(review: ScoreReview): ScoreReview {
  const canonical = createScoreReview({
    disposition: review.disposition,
    rasterSafe: review.disposition === "raster-fallback",
    decisions: review.decisions
  });
  if (review.selectedLane !== canonical.selectedLane || review.exitCode !== canonical.exitCode) {
    throw new ScoreQualityReportContractError("review outcome does not match its disposition");
  }
  return canonical;
}

function canonicalGeneratedAt(generatedAt: string): string {
  const timestamp = Date.parse(generatedAt);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== generatedAt) {
    throw new ScoreQualityReportContractError("generatedAt must be an ISO-8601 UTC timestamp");
  }
  return generatedAt;
}

function canonicalFrames(frames: readonly FrameDisposition[]): readonly FrameDisposition[] {
  let acceptedScoreCount = 0;
  let acceptedPageNumber = 0;
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
        if (frame.pageNumber < acceptedPageNumber) {
          throw new ScoreQualityReportContractError("accepted frame page lineage must be monotonic");
        }
        acceptedPageNumber = frame.pageNumber;
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
