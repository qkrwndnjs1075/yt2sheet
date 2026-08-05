import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import sharp from "sharp";
import { z } from "zod";
import { STANDALONE_SCORE_PDF } from "./score-identity-config";

export type RasterReviewPolicy = {
  readonly edgeBandMinimumPx: number;
  readonly edgeBandStaffGapFraction: number;
  readonly boundaryInkRatioHard: number;
  readonly componentCrossingStaffGapsHard: number;
  readonly renderedStaffGapHardPx: number;
  readonly inkContrastHard: number;
  readonly inkContrastWarningMax: number;
  readonly contaminationWarning: number;
  readonly contaminationHard: number;
  readonly duplicateOverlapWarning: number;
  readonly duplicateStaffGapDeltaWarning: number;
};

export const RASTER_REVIEW_POLICY = {
  edgeBandMinimumPx: 2,
  edgeBandStaffGapFraction: 0.5,
  boundaryInkRatioHard: 0.002,
  componentCrossingStaffGapsHard: 1,
  renderedStaffGapHardPx: 6,
  inkContrastHard: 12,
  inkContrastWarningMax: 23,
  contaminationWarning: 0.01,
  contaminationHard: 0.05,
  duplicateOverlapWarning: 0.6,
  duplicateStaffGapDeltaWarning: 0.08
} as const satisfies RasterReviewPolicy;

export const RASTER_REVIEW_POLICY_DIGEST = digestPolicy(RASTER_REVIEW_POLICY);

const finiteNonNegative = z.number().finite().nonnegative();
const positiveInteger = z.number().int().positive();
const ratio = finiteNonNegative.max(1);
const policySchema = z.object({
  edgeBandMinimumPx: finiteNonNegative,
  edgeBandStaffGapFraction: finiteNonNegative,
  boundaryInkRatioHard: ratio,
  componentCrossingStaffGapsHard: finiteNonNegative,
  renderedStaffGapHardPx: finiteNonNegative,
  inkContrastHard: finiteNonNegative,
  inkContrastWarningMax: finiteNonNegative,
  contaminationWarning: ratio,
  contaminationHard: ratio,
  duplicateOverlapWarning: ratio,
  duplicateStaffGapDeltaWarning: ratio
}).strict();
const pageSchema = z.object({
  pageNumber: positiveInteger,
  contentWidthPx: z.number().finite().positive(),
  staffGapPx: z.number().finite().positive(),
  boundaryConnectedNotationWidthPx: finiteNonNegative,
  boundaryComponentCrossingPx: finiteNonNegative,
  renderedStaffGapPx: finiteNonNegative,
  inkContrast: finiteNonNegative,
  nonNotationCoverage: ratio,
  notationKind: z.enum(["standard", "grand-staff", "tab"]),
  delayedTitle: z.boolean().optional(),
  boundaryKind: z.enum(["none", "edge-fragment", "lower-staff"]).optional(),
  contaminationKind: z.enum(["clean", "watermark", "photo"]).optional()
}).strict();
const acceptedScoreSchema = z.object({ frameNumber: positiveInteger, scoreNumber: positiveInteger, pageNumber: positiveInteger }).strict();
const pageLineageSchema = z.object({ pageNumber: positiveInteger, scoreNumbers: z.array(positiveInteger).min(1) }).strict();
const duplicateSchema = z.object({
  leftScoreNumber: positiveInteger, rightScoreNumber: positiveInteger, notationOverlap: ratio,
  staffGapDelta: ratio, resolvedByLegacy: z.boolean()
}).strict();
const authorityTokenSchema = z.unknown().refine((value) => value !== undefined, "authority token is required");
const reviewInputSchema = z.object({
  session: authorityTokenSchema,
  configDigest: z.string().regex(/^[a-f0-9]{64}$/),
  calibrationProvenance: z.unknown().optional(),
  pages: z.array(pageSchema).min(1),
  acceptedScores: z.array(acceptedScoreSchema).min(1),
  pageLineage: z.array(pageLineageSchema).min(1),
  duplicates: z.array(duplicateSchema)
}).strict();
const calibrationSchema = z.object({
  session: authorityTokenSchema, split: z.literal("calibration"),
  baseConfigDigest: z.string().regex(/^[a-f0-9]{64}$/), thresholds: policySchema.partial().strict()
}).strict();

export type RasterReviewFinding = {
  readonly pageNumber: number | null;
  readonly code: "RASTER_LINEAGE_INVALID" | "RASTER_CROP_CLIPPED" | "RASTER_UNREADABLE" | "RASTER_CONTAMINATED" | "RASTER_LOW_CONTRAST" | "RASTER_DUPLICATE_AMBIGUOUS";
  readonly severity: "hard" | "warning";
  readonly evidence: Readonly<Record<string, number>>;
};

export type RasterReviewResult = {
  readonly status: "pass" | "warning" | "blocked";
  readonly omrEligible: boolean;
  readonly findings: readonly RasterReviewFinding[];
  readonly pages: readonly {
    readonly pageNumber: number;
    readonly edgeBandPx: number;
    readonly boundaryInkRatio: number;
    readonly contamination: "clean" | "warning" | "hard";
  }[];
  readonly configDigest: string;
};

export type RasterReviewPageInput = {
  readonly path: string;
  readonly lineage: {
    readonly pageNumber: number;
    readonly sourceFrameIds: readonly string[];
    readonly sourceScoreIds: readonly string[];
  };
};

export type RasterReviewCalibrationProvenance = { readonly configDigest: string };
export type RasterReviewSession = { readonly kind: "raster-review-session" };
type RasterReviewSessionState = { phase: "calibration" | "review" };

const sessionStates = new WeakMap<object, RasterReviewSessionState>();
const calibratedPolicies = new WeakMap<object, {
  readonly session: object;
  readonly policy: RasterReviewPolicy;
  readonly configDigest: string;
}>();

export class RasterReviewInputError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = "RasterReviewInputError";
  }
}

export function createRasterReviewSession(): RasterReviewSession {
  const session = Object.freeze({ kind: "raster-review-session" as const });
  sessionStates.set(session, { phase: "calibration" });
  return session;
}

export function reviewRasterSource(rawInput: unknown): RasterReviewResult {
  const input = parse(reviewInputSchema, rawInput, "invalid raster review input");
  const session = resolveSession(input.session);
  session.state.phase = "review";
  const calibration = resolveCalibration(input.calibrationProvenance, session.authority);
  const policy = calibration?.policy ?? RASTER_REVIEW_POLICY;
  assertPolicy(policy);
  const configDigest = calibration?.configDigest ?? RASTER_REVIEW_POLICY_DIGEST;
  if (input.configDigest !== configDigest) throw new RasterReviewInputError("stale raster review config digest");
  const findings: RasterReviewFinding[] = [];
  const lineageFailure = findLineageFailure(input.acceptedScores, input.pageLineage, input.pages.map((page) => page.pageNumber));
  if (lineageFailure !== null) findings.push(lineageFailure);
  const pages = input.pages.map((page) => {
    const edgeBandPx = Math.max(policy.edgeBandMinimumPx, Math.round(page.staffGapPx * policy.edgeBandStaffGapFraction));
    const boundaryInkRatio = page.boundaryConnectedNotationWidthPx / page.contentWidthPx;
    const staffGapCrossing = page.boundaryComponentCrossingPx / page.staffGapPx;
    if (boundaryInkRatio >= policy.boundaryInkRatioHard || staffGapCrossing >= policy.componentCrossingStaffGapsHard) {
      findings.push(finding(page.pageNumber, "RASTER_CROP_CLIPPED", "hard", { boundaryInkRatio, staffGapCrossing }));
    }
    if (page.renderedStaffGapPx < policy.renderedStaffGapHardPx || page.inkContrast < policy.inkContrastHard) {
      findings.push(finding(page.pageNumber, "RASTER_UNREADABLE", "hard", { renderedStaffGapPx: page.renderedStaffGapPx, inkContrast: page.inkContrast }));
    } else if (page.inkContrast <= policy.inkContrastWarningMax) {
      findings.push(finding(page.pageNumber, "RASTER_LOW_CONTRAST", "warning", { inkContrast: page.inkContrast }));
    }
    const contamination: "clean" | "warning" | "hard" = page.nonNotationCoverage > policy.contaminationHard ? "hard"
      : page.nonNotationCoverage >= policy.contaminationWarning ? "warning" : "clean";
    if (contamination === "hard") {
      findings.push(finding(page.pageNumber, "RASTER_CONTAMINATED", "hard", { nonNotationCoverage: page.nonNotationCoverage }));
    }
    return { pageNumber: page.pageNumber, edgeBandPx, boundaryInkRatio, contamination };
  });
  for (const duplicate of input.duplicates) {
    if (!duplicate.resolvedByLegacy
      && duplicate.notationOverlap >= policy.duplicateOverlapWarning
      && duplicate.staffGapDelta <= policy.duplicateStaffGapDeltaWarning) {
      findings.push(finding(null, "RASTER_DUPLICATE_AMBIGUOUS", "warning", {
        notationOverlap: duplicate.notationOverlap,
        staffGapDelta: duplicate.staffGapDelta
      }));
    }
  }
  const blocked = findings.some((entry) => entry.severity === "hard");
  const warned = findings.length > 0 || pages.some((page) => page.contamination === "warning");
  return {
    status: blocked ? "blocked" : warned ? "warning" : "pass",
    omrEligible: !blocked,
    findings,
    pages,
    configDigest
  };
}

export async function reviewRasterPageFiles(
  pages: readonly RasterReviewPageInput[],
  signal?: AbortSignal
): Promise<RasterReviewResult> {
  const observations: Array<{
    readonly pageNumber: number;
    readonly contentWidthPx: number;
    readonly staffGapPx: number;
    readonly boundaryConnectedNotationWidthPx: number;
    readonly boundaryComponentCrossingPx: number;
    readonly renderedStaffGapPx: number;
    readonly inkContrast: number;
    readonly nonNotationCoverage: number;
    readonly notationKind: "standard";
  }> = [];
  const acceptedScores: Array<{ readonly frameNumber: number; readonly scoreNumber: number; readonly pageNumber: number }> = [];
  const pageLineage: Array<{ readonly pageNumber: number; readonly scoreNumbers: readonly number[] }> = [];

  for (let index = 0; index < pages.length; index += 1) {
    throwIfRasterReviewCancelled(signal);
    const page = pages[index];
    if (page === undefined || page.lineage.pageNumber !== index + 1) {
      return blockedRasterReview(pages.length, index + 1, "RASTER_LINEAGE_INVALID", { expectedPageNumber: index + 1, actualPageNumber: page?.lineage.pageNumber ?? 0 });
    }
    const lineage = parseRasterLineage(page, index + 1);
    if (lineage === null) {
      return blockedRasterReview(pages.length, index + 1, "RASTER_LINEAGE_INVALID", { expectedPageNumber: index + 1, actualPageNumber: page.lineage.pageNumber });
    }
    const observation = await inspectRasterPageFile(page.path, index + 1, signal);
    if (observation === null) {
      return blockedRasterReview(pages.length, index + 1, "RASTER_UNREADABLE", { renderedStaffGapPx: 0, inkContrast: 0 });
    }
    observations.push(observation);
    pageLineage.push({ pageNumber: index + 1, scoreNumbers: lineage.scoreNumbers });
    acceptedScores.push(...lineage.acceptedScores);
  }

  try {
    return reviewRasterSource({
      session: createRasterReviewSession(),
      configDigest: RASTER_REVIEW_POLICY_DIGEST,
      pages: observations,
      acceptedScores,
      pageLineage,
      duplicates: []
    });
  } catch (error) {
    if (error instanceof RasterReviewInputError) {
      return blockedRasterReview(pages.length, null, "RASTER_LINEAGE_INVALID", { expectedPageNumber: pages.length, actualPageNumber: 0 });
    }
    throw error;
  }
}

function parseRasterLineage(
  page: RasterReviewPageInput,
  pageNumber: number
): { readonly scoreNumbers: readonly number[]; readonly acceptedScores: readonly { readonly frameNumber: number; readonly scoreNumber: number; readonly pageNumber: number }[] } | null {
  const frameIds = page.lineage.sourceFrameIds;
  const scoreIds = page.lineage.sourceScoreIds;
  if (frameIds.length === 0 || scoreIds.length === 0 || frameIds.length !== scoreIds.length) return null;
  const acceptedScores: Array<{ readonly frameNumber: number; readonly scoreNumber: number; readonly pageNumber: number }> = [];
  const scoreNumbers: number[] = [];
  for (let index = 0; index < scoreIds.length; index += 1) {
    const frameNumber = parseLineageNumber(frameIds[index], "frame");
    const scoreNumber = parseLineageNumber(scoreIds[index], "score");
    if (frameNumber === null || scoreNumber === null) return null;
    acceptedScores.push({ frameNumber, scoreNumber, pageNumber });
    scoreNumbers.push(scoreNumber);
  }
  return { scoreNumbers, acceptedScores };
}

function parseLineageNumber(value: string | undefined, prefix: "frame" | "score"): number | null {
  const match = value === undefined ? null : new RegExp(`^${prefix}-(\\d+)$`, "u").exec(value);
  if (match === null) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

async function inspectRasterPageFile(path: string, pageNumber: number, signal?: AbortSignal): Promise<{
  readonly pageNumber: number;
  readonly contentWidthPx: number;
  readonly staffGapPx: number;
  readonly boundaryConnectedNotationWidthPx: number;
  readonly boundaryComponentCrossingPx: number;
  readonly renderedStaffGapPx: number;
  readonly inkContrast: number;
  readonly nonNotationCoverage: number;
  readonly notationKind: "standard";
} | null> {
  try {
    const file = await lstat(path);
    if (!file.isFile() || file.isSymbolicLink()) return null;
    const metadata = await sharp(path, { limitInputPixels: STANDALONE_SCORE_PDF.rasterWidth * STANDALONE_SCORE_PDF.rasterHeight }).metadata();
    if (metadata.width !== STANDALONE_SCORE_PDF.rasterWidth || metadata.height !== STANDALONE_SCORE_PDF.rasterHeight) return null;
    const { data, info } = await sharp(path)
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    throwIfRasterReviewCancelled(signal);
    return deriveRasterObservation(pageNumber, data, info.width, info.height, signal);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    if (isRasterFileAccessError(error) || error instanceof Error) return null;
    throw error;
  }
}

function deriveRasterObservation(
  pageNumber: number,
  pixels: Uint8Array,
  width: number,
  height: number,
  signal?: AbortSignal
): {
  readonly pageNumber: number;
  readonly contentWidthPx: number;
  readonly staffGapPx: number;
  readonly boundaryConnectedNotationWidthPx: number;
  readonly boundaryComponentCrossingPx: number;
  readonly renderedStaffGapPx: number;
  readonly inkContrast: number;
  readonly nonNotationCoverage: number;
  readonly notationKind: "standard";
} {
  const margin = STANDALONE_SCORE_PDF.contentMarginPixels;
  const darkThreshold = 250;
  const rowDarkCounts = new Uint32Array(height);
  let darkPixels = 0;
  let outsideDarkPixels = 0;
  let minimum = 255;
  let maximum = 0;
  let leftBoundaryColumns = 0;
  let rightBoundaryColumns = 0;
  for (let y = 0; y < height; y += 1) {
    if (y % 64 === 0) throwIfRasterReviewCancelled(signal);
    for (let x = 0; x < width; x += 1) {
      const value = pixels[y * width + x] ?? 255;
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
      if (value >= darkThreshold) continue;
      darkPixels += 1;
      rowDarkCounts[y] = (rowDarkCounts[y] ?? 0) + 1;
      if (x < margin || x >= width - margin || y < margin || y >= height - margin) outsideDarkPixels += 1;
      if (x < margin) leftBoundaryColumns = Math.max(leftBoundaryColumns, margin - x);
      if (x >= width - margin) rightBoundaryColumns = Math.max(rightBoundaryColumns, x - (width - margin) + 1);
    }
  }
  const staffRows = rowCenters(rowDarkCounts, Math.max(8, Math.floor(width * 0.2)));
  const gaps = staffRows.slice(1).map((row, index) => row - (staffRows[index] ?? row)).filter((gap) => gap > 0);
  const staffGapPx = median(gaps) ?? (darkPixels > 0 ? 1 : 0.001);
  return {
    pageNumber,
    contentWidthPx: Math.max(1, width - margin * 2),
    staffGapPx,
    boundaryConnectedNotationWidthPx: Math.max(leftBoundaryColumns, rightBoundaryColumns),
    boundaryComponentCrossingPx: Math.max(leftBoundaryColumns, rightBoundaryColumns),
    renderedStaffGapPx: gaps.length === 0 ? 0 : staffGapPx,
    inkContrast: maximum - minimum,
    nonNotationCoverage: outsideDarkPixels / Math.max(1, width * height),
    notationKind: "standard"
  };
}

function rowCenters(rowDarkCounts: Uint32Array, threshold: number): number[] {
  const centers: number[] = [];
  let start = -1;
  for (let index = 0; index <= rowDarkCounts.length; index += 1) {
    const active = index < rowDarkCounts.length && (rowDarkCounts[index] ?? 0) >= threshold;
    if (active && start < 0) start = index;
    if (!active && start >= 0) {
      centers.push(Math.round((start + index - 1) / 2));
      start = -1;
    }
  }
  return centers;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

function blockedRasterReview(
  pageCount: number,
  pageNumber: number | null,
  code: "RASTER_LINEAGE_INVALID" | "RASTER_UNREADABLE",
  evidence: Readonly<Record<string, number>>
): RasterReviewResult {
  return {
    status: "blocked",
    omrEligible: false,
    findings: [{ pageNumber, code, severity: "hard", evidence }],
    pages: Array.from({ length: pageCount }, (_, index) => ({ pageNumber: index + 1, edgeBandPx: 2, boundaryInkRatio: 0, contamination: "clean" as const })),
    configDigest: RASTER_REVIEW_POLICY_DIGEST
  };
}

function throwIfRasterReviewCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
}

function isRasterFileAccessError(error: unknown): boolean {
  return error instanceof Error && "code" in error;
}

export function calibrateRasterReviewPolicy(rawInput: unknown): {
  readonly policy: RasterReviewPolicy;
  readonly configDigest: string;
  readonly provenance: RasterReviewCalibrationProvenance;
} {
  const input = parse(calibrationSchema, rawInput, "invalid raster calibration input");
  const session = resolveSession(input.session);
  if (session.state.phase !== "calibration") throw new RasterReviewInputError("raster review session has started test execution");
  if (input.baseConfigDigest !== RASTER_REVIEW_POLICY_DIGEST) throw new RasterReviewInputError("stale calibration base config digest");
  const policy: RasterReviewPolicy = Object.freeze({ ...RASTER_REVIEW_POLICY, ...input.thresholds });
  assertPolicy(policy);
  const configDigest = digestPolicy(policy);
  const provenance = Object.freeze({ configDigest });
  calibratedPolicies.set(provenance, { session: session.authority, policy, configDigest });
  return { policy, configDigest, provenance };
}

function resolveSession(value: unknown): { readonly authority: object; readonly state: RasterReviewSessionState } {
  if (typeof value !== "object" || value === null) throw new RasterReviewInputError("invalid raster review session");
  const state = sessionStates.get(value);
  if (state === undefined) throw new RasterReviewInputError("untrusted raster review session");
  return { authority: value, state };
}

function resolveCalibration(value: unknown, session: object): { readonly policy: RasterReviewPolicy; readonly configDigest: string } | null {
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null) throw new RasterReviewInputError("invalid raster calibration provenance");
  const calibration = calibratedPolicies.get(value);
  if (calibration === undefined) throw new RasterReviewInputError("untrusted raster calibration provenance");
  if (calibration.session !== session) throw new RasterReviewInputError("raster calibration provenance belongs to another session");
  return calibration;
}

function findLineageFailure(
  acceptedScores: readonly z.infer<typeof acceptedScoreSchema>[],
  pages: readonly z.infer<typeof pageLineageSchema>[],
  observedPageNumbers: readonly number[]
): RasterReviewFinding | null {
  for (let index = 1; index < acceptedScores.length; index += 1) {
    const previous = acceptedScores[index - 1];
    const current = acceptedScores[index];
    if (current.frameNumber <= previous.frameNumber || current.scoreNumber <= previous.scoreNumber || current.pageNumber < previous.pageNumber) {
      return finding(current.pageNumber, "RASTER_LINEAGE_INVALID", "hard", {
        expectedPageNumber: previous.pageNumber,
        actualPageNumber: current.pageNumber
      });
    }
  }
  for (let index = 0; index < pages.length; index += 1) {
    const expected = index + 1;
    const current = pages[index];
    if (current.pageNumber !== expected || observedPageNumbers[index] !== expected) {
      const actualPageNumber = current.pageNumber !== expected ? current.pageNumber : observedPageNumbers[index] ?? 0;
      return finding(actualPageNumber, "RASTER_LINEAGE_INVALID", "hard", { expectedPageNumber: expected, actualPageNumber });
    }
    const acceptedOnPage = acceptedScores.filter((score) => score.pageNumber === current.pageNumber).map((score) => score.scoreNumber);
    if (acceptedOnPage.length !== current.scoreNumbers.length || acceptedOnPage.some((score, scoreIndex) => score !== current.scoreNumbers[scoreIndex])) {
      return finding(current.pageNumber, "RASTER_LINEAGE_INVALID", "hard", { expectedPageNumber: current.pageNumber, actualPageNumber: 0 });
    }
  }
  if (pages.length !== observedPageNumbers.length || acceptedScores.some((score) => score.pageNumber > pages.length)) {
    return finding(null, "RASTER_LINEAGE_INVALID", "hard", { expectedPageNumber: pages.length, actualPageNumber: observedPageNumbers.length });
  }
  return null;
}

function finding(pageNumber: number | null, code: RasterReviewFinding["code"], severity: RasterReviewFinding["severity"], evidence: Readonly<Record<string, number>>): RasterReviewFinding {
  return { pageNumber, code, severity, evidence };
}

function assertPolicy(policy: RasterReviewPolicy): void {
  if (policy.inkContrastHard > policy.inkContrastWarningMax
    || policy.contaminationWarning > policy.contaminationHard) {
    throw new RasterReviewInputError("raster review thresholds are inconsistent");
  }
}

function digestPolicy(policy: RasterReviewPolicy): string {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}

function parse<T>(schema: z.ZodType<T>, value: unknown, detail: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new RasterReviewInputError(`${detail}: ${result.error.issues[0]?.message ?? "unknown error"}`);
  return result.data;
}
