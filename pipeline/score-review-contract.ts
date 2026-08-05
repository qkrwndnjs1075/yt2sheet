export const SCORE_REVIEW_CODES = [
  "NO_SCORE_DETECTED",
  "RASTER_LINEAGE_INVALID",
  "RASTER_CROP_CLIPPED",
  "RASTER_UNREADABLE",
  "RASTER_CONTAMINATED",
  "FINAL_PDF_INVALID",
  "PUBLICATION_FAILED",
  "RASTER_LOW_CONTRAST",
  "RASTER_DUPLICATE_AMBIGUOUS",
  "OMR_UNAVAILABLE",
  "OMR_TIMEOUT",
  "OMR_FAILED",
  "MXL_UNSAFE",
  "MUSICXML_INVALID",
  "STRUCTURED_LINEAGE_MISMATCH",
  "ENGRAVER_UNAVAILABLE",
  "ENGRAVER_TIMEOUT",
  "ENGRAVER_FAILED",
  "STRUCTURED_PDF_INVALID",
  "STRUCTURED_SELECTED",
  "RASTER_FALLBACK_SELECTED"
] as const;

export type ScoreReviewCode = typeof SCORE_REVIEW_CODES[number];
export type ScoreReviewLayer = "detection" | "raster" | "structured" | "final-pdf" | "publication" | "selection";
export type ScoreReviewSeverity = "hard" | "warning" | "informational";
export type ScoreReviewDisposition = "blocked" | "structured" | "raster-fallback";
export type ScoreReviewLane = "structured" | "raster" | null;
export type ScoreReviewEvidenceValue = string | number | boolean;

export type ScoreReviewCodeContract = {
  readonly code: ScoreReviewCode;
  readonly layer: ScoreReviewLayer;
  readonly evidenceFields: readonly string[];
  readonly severity: ScoreReviewSeverity;
  readonly selectedLane: ScoreReviewLane;
  readonly cliMessage: string;
  readonly exitCode: 0 | 1;
  readonly internalRepresentation: "hard-failure" | "fallback-warning" | "selection";
};

export type ScoreReviewDecisionInput = {
  readonly pageNumber: number | null;
  readonly code: ScoreReviewCode;
  readonly evidence: Readonly<Record<string, ScoreReviewEvidenceValue>>;
};

export type ScoreReviewDecision = ScoreReviewDecisionInput;

export type ScoreReviewInput = {
  readonly disposition: ScoreReviewDisposition;
  readonly rasterSafe: boolean;
  readonly decisions: readonly ScoreReviewDecisionInput[];
};

export type ScoreReview = {
  readonly disposition: ScoreReviewDisposition;
  readonly selectedLane: ScoreReviewLane;
  readonly exitCode: 0 | 1;
  readonly decisions: readonly ScoreReviewDecision[];
};

export class ScoreReviewContractError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = "ScoreReviewContractError";
  }
}

export const SCORE_REVIEW_CODE_CONTRACTS: readonly ScoreReviewCodeContract[] = [
  { code: "NO_SCORE_DETECTED", layer: "detection", evidenceFields: ["frameCount"], severity: "hard", selectedLane: null, cliMessage: "No score was detected.", exitCode: 1, internalRepresentation: "hard-failure" },
  { code: "RASTER_LINEAGE_INVALID", layer: "raster", evidenceFields: ["expectedPageNumber", "actualPageNumber"], severity: "hard", selectedLane: null, cliMessage: "Raster page order is invalid.", exitCode: 1, internalRepresentation: "hard-failure" },
  { code: "RASTER_CROP_CLIPPED", layer: "raster", evidenceFields: ["boundaryInkRatio", "staffGapCrossing"], severity: "hard", selectedLane: null, cliMessage: "Raster score content is clipped.", exitCode: 1, internalRepresentation: "hard-failure" },
  { code: "RASTER_UNREADABLE", layer: "raster", evidenceFields: ["renderedStaffGapPx", "inkContrast"], severity: "hard", selectedLane: null, cliMessage: "Raster score is unreadable.", exitCode: 1, internalRepresentation: "hard-failure" },
  { code: "RASTER_CONTAMINATED", layer: "raster", evidenceFields: ["nonNotationCoverage"], severity: "hard", selectedLane: null, cliMessage: "Raster score contains excessive non-notation content.", exitCode: 1, internalRepresentation: "hard-failure" },
  { code: "FINAL_PDF_INVALID", layer: "final-pdf", evidenceFields: ["validationReason"], severity: "hard", selectedLane: null, cliMessage: "Final PDF validation failed.", exitCode: 1, internalRepresentation: "hard-failure" },
  { code: "PUBLICATION_FAILED", layer: "publication", evidenceFields: ["operation", "reason"], severity: "hard", selectedLane: null, cliMessage: "Score PDF publication failed.", exitCode: 1, internalRepresentation: "hard-failure" },
  { code: "RASTER_LOW_CONTRAST", layer: "raster", evidenceFields: ["inkContrast"], severity: "warning", selectedLane: "raster", cliMessage: "Using readable low-contrast raster score.", exitCode: 0, internalRepresentation: "fallback-warning" },
  { code: "RASTER_DUPLICATE_AMBIGUOUS", layer: "raster", evidenceFields: ["notationOverlap", "staffGapDelta"], severity: "warning", selectedLane: "raster", cliMessage: "Using raster score with ambiguous duplicate evidence.", exitCode: 0, internalRepresentation: "fallback-warning" },
  { code: "OMR_UNAVAILABLE", layer: "structured", evidenceFields: ["tool", "versionProbe"], severity: "warning", selectedLane: "raster", cliMessage: "OMR is unavailable; using raster fallback.", exitCode: 0, internalRepresentation: "fallback-warning" },
  { code: "OMR_TIMEOUT", layer: "structured", evidenceFields: ["timeoutMs"], severity: "warning", selectedLane: "raster", cliMessage: "OMR timed out; using raster fallback.", exitCode: 0, internalRepresentation: "fallback-warning" },
  { code: "OMR_FAILED", layer: "structured", evidenceFields: ["exitCode", "logSummary"], severity: "warning", selectedLane: "raster", cliMessage: "OMR failed; using raster fallback.", exitCode: 0, internalRepresentation: "fallback-warning" },
  { code: "MXL_UNSAFE", layer: "structured", evidenceFields: ["reason"], severity: "warning", selectedLane: "raster", cliMessage: "Unsafe MXL was rejected; using raster fallback.", exitCode: 0, internalRepresentation: "fallback-warning" },
  { code: "MUSICXML_INVALID", layer: "structured", evidenceFields: ["validationReason"], severity: "warning", selectedLane: "raster", cliMessage: "Invalid MusicXML was rejected; using raster fallback.", exitCode: 0, internalRepresentation: "fallback-warning" },
  { code: "STRUCTURED_LINEAGE_MISMATCH", layer: "structured", evidenceFields: ["expectedPageNumber", "actualPageNumber"], severity: "warning", selectedLane: "raster", cliMessage: "Structured page lineage mismatched; using raster fallback.", exitCode: 0, internalRepresentation: "fallback-warning" },
  { code: "ENGRAVER_UNAVAILABLE", layer: "structured", evidenceFields: ["tool", "versionProbe"], severity: "warning", selectedLane: "raster", cliMessage: "Engraver is unavailable; using raster fallback.", exitCode: 0, internalRepresentation: "fallback-warning" },
  { code: "ENGRAVER_TIMEOUT", layer: "structured", evidenceFields: ["timeoutMs"], severity: "warning", selectedLane: "raster", cliMessage: "Engraver timed out; using raster fallback.", exitCode: 0, internalRepresentation: "fallback-warning" },
  { code: "ENGRAVER_FAILED", layer: "structured", evidenceFields: ["exitCode", "logSummary"], severity: "warning", selectedLane: "raster", cliMessage: "Engraver failed; using raster fallback.", exitCode: 0, internalRepresentation: "fallback-warning" },
  { code: "STRUCTURED_PDF_INVALID", layer: "structured", evidenceFields: ["validationReason"], severity: "warning", selectedLane: "raster", cliMessage: "Structured PDF validation failed; using raster fallback.", exitCode: 0, internalRepresentation: "fallback-warning" },
  { code: "STRUCTURED_SELECTED", layer: "selection", evidenceFields: ["pageCount"], severity: "informational", selectedLane: "structured", cliMessage: "Structured score PDF selected.", exitCode: 0, internalRepresentation: "selection" },
  { code: "RASTER_FALLBACK_SELECTED", layer: "selection", evidenceFields: ["pageCount"], severity: "informational", selectedLane: "raster", cliMessage: "Raster fallback PDF selected.", exitCode: 0, internalRepresentation: "selection" }
];

const CONTRACT_BY_CODE = new Map(SCORE_REVIEW_CODE_CONTRACTS.map((entry) => [entry.code, entry]));
const CODE_ORDER = new Map(SCORE_REVIEW_CODES.map((code, index) => [code, index]));
const STRUCTURED_FAILURE_CODES = new Set(SCORE_REVIEW_CODE_CONTRACTS
  .filter((entry) => entry.layer === "structured" && entry.severity === "warning")
  .map((entry) => entry.code));

export function createScoreReview(input: ScoreReviewInput): ScoreReview {
  const decisions = input.decisions.map(canonicalDecision).sort(compareDecisions);
  for (let index = 1; index < decisions.length; index += 1) {
    const current = decisions[index];
    const previous = decisions[index - 1];
    if (current !== undefined && previous !== undefined && current.pageNumber === previous.pageNumber && current.code === previous.code) {
      throw new ScoreReviewContractError(`duplicate review decision: ${current.pageNumber ?? "document"}/${current.code}`);
    }
  }
  const hasHardFailure = decisions.some((decision) => scoreReviewContract(decision.code).severity === "hard");
  const hasWarning = decisions.some((decision) => scoreReviewContract(decision.code).severity === "warning");
  const hasStructuredFailure = decisions.some((decision) => STRUCTURED_FAILURE_CODES.has(decision.code));
  const selectedLane = selectedLaneFor(input.disposition);
  if (input.rasterSafe && hasStructuredFailure && input.disposition !== "raster-fallback") {
    throw new ScoreReviewContractError("safe raster requires raster-fallback for structured failures");
  }
  if (hasWarning && input.disposition !== "raster-fallback") {
    throw new ScoreReviewContractError("warning review requires raster-fallback disposition");
  }
  if (input.disposition === "raster-fallback" && !input.rasterSafe) {
    throw new ScoreReviewContractError("raster-fallback requires a safe raster lane");
  }
  if (input.disposition === "blocked" && !hasHardFailure) {
    throw new ScoreReviewContractError("blocked review requires a hard failure");
  }
  if (input.disposition !== "blocked" && hasHardFailure) {
    throw new ScoreReviewContractError("hard failure requires blocked disposition");
  }
  assertSelectionDecision(input.disposition, decisions);
  return { disposition: input.disposition, selectedLane, exitCode: input.disposition === "blocked" ? 1 : 0, decisions };
}

export function scoreReviewContract(code: ScoreReviewCode): ScoreReviewCodeContract {
  const entry = CONTRACT_BY_CODE.get(code);
  if (entry === undefined) throw new ScoreReviewContractError(`unknown review code: ${String(code)}`);
  return entry;
}

function canonicalDecision(decision: ScoreReviewDecisionInput): ScoreReviewDecision {
  if (decision.pageNumber !== null && (!Number.isSafeInteger(decision.pageNumber) || decision.pageNumber < 1)) {
    throw new ScoreReviewContractError("review decision page number must be null or a 1-based integer");
  }
  const entry = scoreReviewContract(decision.code);
  const actualFields = Object.keys(decision.evidence).sort();
  const expectedFields = [...entry.evidenceFields].sort();
  if (actualFields.length !== expectedFields.length || actualFields.some((field, index) => field !== expectedFields[index])) {
    throw new ScoreReviewContractError(`${decision.code} evidence must contain exactly: ${expectedFields.join(", ")}`);
  }
  const evidence: Record<string, ScoreReviewEvidenceValue> = {};
  for (const field of entry.evidenceFields) {
    const value = decision.evidence[field];
    if (typeof value !== "string" && typeof value !== "boolean" && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new ScoreReviewContractError(`${decision.code} evidence field ${field} must be a finite scalar`);
    }
    evidence[field] = value;
  }
  return { pageNumber: decision.pageNumber, code: decision.code, evidence };
}

function compareDecisions(left: ScoreReviewDecision, right: ScoreReviewDecision): number {
  const pageDelta = (left.pageNumber ?? 0) - (right.pageNumber ?? 0);
  if (pageDelta !== 0) return pageDelta;
  return codeOrder(left.code) - codeOrder(right.code);
}

function codeOrder(code: ScoreReviewCode): number {
  const order = CODE_ORDER.get(code);
  if (order === undefined) throw new ScoreReviewContractError(`unknown review code: ${String(code)}`);
  return order;
}

function selectedLaneFor(disposition: ScoreReviewDisposition): ScoreReviewLane {
  switch (disposition) {
    case "blocked": return null;
    case "structured": return "structured";
    case "raster-fallback": return "raster";
    default: return assertNever(disposition);
  }
}

function assertSelectionDecision(disposition: ScoreReviewDisposition, decisions: readonly ScoreReviewDecision[]): void {
  const requiredCode = disposition === "structured" ? "STRUCTURED_SELECTED" : disposition === "raster-fallback" ? "RASTER_FALLBACK_SELECTED" : null;
  const selectionCodes = decisions.filter((decision) => scoreReviewContract(decision.code).internalRepresentation === "selection");
  if (requiredCode === null && selectionCodes.length !== 0) throw new ScoreReviewContractError("blocked review cannot select a lane");
  if (requiredCode !== null && (selectionCodes.length !== 1 || selectionCodes[0]?.code !== requiredCode)) {
    throw new ScoreReviewContractError(`${disposition} review requires ${requiredCode}`);
  }
}

function assertNever(value: never): never {
  throw new ScoreReviewContractError(`unexpected review disposition: ${String(value)}`);
}
