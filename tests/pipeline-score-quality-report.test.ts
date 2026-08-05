import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ScoreQualityReportContractError,
  createScoreExtractionQualityReport,
  deriveScoreQualitySidecarPath,
  frameIdentifier,
  resolveDuplicateReason,
  scoreIdentifier,
  serializeScoreExtractionQualityReport
} from "../pipeline/score-quality-report";
import {
  SCORE_REVIEW_CODES,
  SCORE_REVIEW_CODE_CONTRACTS,
  ScoreReviewContractError,
  createScoreReview,
  type ScoreReviewDecisionInput
} from "../pipeline/score-review-contract";

const decision = (value: ScoreReviewDecisionInput): ScoreReviewDecisionInput => value;

const REVIEW_DECISIONS = [
  decision({ pageNumber: null, code: "NO_SCORE_DETECTED", evidence: { frameCount: 0 } }),
  decision({ pageNumber: 2, code: "RASTER_LINEAGE_INVALID", evidence: { expectedPageNumber: 2, actualPageNumber: 3 } }),
  decision({ pageNumber: 2, code: "RASTER_CROP_CLIPPED", evidence: { boundaryInkRatio: 0.002, staffGapCrossing: 1 } }),
  decision({ pageNumber: 2, code: "RASTER_UNREADABLE", evidence: { renderedStaffGapPx: 5, inkContrast: 11 } }),
  decision({ pageNumber: 2, code: "RASTER_CONTAMINATED", evidence: { nonNotationCoverage: 0.051 } }),
  decision({ pageNumber: null, code: "FINAL_PDF_INVALID", evidence: { validationReason: "page box" } }),
  decision({ pageNumber: null, code: "PUBLICATION_FAILED", evidence: { operation: "rename", reason: "permission" } }),
  decision({ pageNumber: 1, code: "RASTER_LOW_CONTRAST", evidence: { inkContrast: 20 } }),
  decision({ pageNumber: 1, code: "RASTER_DUPLICATE_AMBIGUOUS", evidence: { notationOverlap: 0.61, staffGapDelta: 0.08 } }),
  decision({ pageNumber: 1, code: "OMR_UNAVAILABLE", evidence: { tool: "audiveris", versionProbe: "missing" } }),
  decision({ pageNumber: 1, code: "OMR_TIMEOUT", evidence: { timeoutMs: 30_000 } }),
  decision({ pageNumber: 1, code: "OMR_FAILED", evidence: { exitCode: 2, logSummary: "failed" } }),
  decision({ pageNumber: 1, code: "MXL_UNSAFE", evidence: { reason: "traversal" } }),
  decision({ pageNumber: 1, code: "MUSICXML_INVALID", evidence: { validationReason: "schema" } }),
  decision({ pageNumber: 1, code: "STRUCTURED_LINEAGE_MISMATCH", evidence: { expectedPageNumber: 1, actualPageNumber: 2 } }),
  decision({ pageNumber: 1, code: "ENGRAVER_UNAVAILABLE", evidence: { tool: "musescore", versionProbe: "missing" } }),
  decision({ pageNumber: 1, code: "ENGRAVER_TIMEOUT", evidence: { timeoutMs: 30_000 } }),
  decision({ pageNumber: 1, code: "ENGRAVER_FAILED", evidence: { exitCode: 2, logSummary: "failed" } }),
  decision({ pageNumber: 1, code: "STRUCTURED_PDF_INVALID", evidence: { validationReason: "media box" } }),
  decision({ pageNumber: null, code: "STRUCTURED_SELECTED", evidence: { pageCount: 2 } }),
  decision({ pageNumber: null, code: "RASTER_FALLBACK_SELECTED", evidence: { pageCount: 2 } })
];

describe("score extraction quality report", () => {
  it("serializes every review code into the canonical decision section", () => {
    // Given: one decision for every review code required by the v2 contract.
    assert.deepEqual(REVIEW_DECISIONS.map((decision) => decision.code), SCORE_REVIEW_CODES);
    assert.deepEqual(SCORE_REVIEW_CODE_CONTRACTS.map((entry) => entry.code), SCORE_REVIEW_CODES);

    for (const decision of REVIEW_DECISIONS) {
      const contract = SCORE_REVIEW_CODE_CONTRACTS.find((entry) => entry.code === decision.code);
      assert.ok(contract);
      assert.notEqual(contract.cliMessage, "");
      assert.notEqual(contract.evidenceFields.length, 0);
      const selection = decision.code === "STRUCTURED_SELECTED" || decision.code === "RASTER_FALLBACK_SELECTED";
      const hard = contract?.severity === "hard";
      if (hard) {
        assert.deepEqual([contract.selectedLane, contract.exitCode, contract.internalRepresentation], [null, 1, "hard-failure"]);
      } else if (selection) {
        assert.deepEqual([contract.severity, contract.exitCode, contract.internalRepresentation], ["informational", 0, "selection"]);
      } else {
        assert.deepEqual([contract.severity, contract.selectedLane, contract.exitCode, contract.internalRepresentation], ["warning", "raster", 0, "fallback-warning"]);
      }
      const disposition = hard ? "blocked" : decision.code === "STRUCTURED_SELECTED" ? "structured" : "raster-fallback";
      const decisions = selection || hard ? [decision] : [decision, REVIEW_DECISIONS[20]];
      const report = createScoreExtractionQualityReport({
        durationsMs: { analysis: 1, deduplication: 1, pageComposition: 1, total: 3 },
        frames: [],
        review: { disposition, rasterSafe: !hard, decisions }
      });

      // When: the report is serialized.
      const serialized = serializeScoreExtractionQualityReport(report);

      // Then: the machine-readable v2 decision is retained.
      assert.match(serialized, new RegExp(`"code":"${decision.code}"`));
      if (hard) assert.deepEqual([report.review.disposition, report.review.selectedLane, report.review.exitCode], ["blocked", null, 1]);
    }
  });

  it("serializes the versioned frame dispositions in canonical order", () => {
    // Given: three sequential frames with one accepted score and one duplicate.
    const report = createScoreExtractionQualityReport({
      durationsMs: { analysis: 12, deduplication: 3, pageComposition: 7, total: 22 },
      frames: [
        { frameId: frameIdentifier(1), disposition: "no-score" },
        { frameId: frameIdentifier(2), disposition: "accepted", scoreId: scoreIdentifier(1), pageNumber: 1 },
        { frameId: frameIdentifier(3), disposition: "duplicate", duplicateReason: resolveDuplicateReason({ nearDuplicate: false, dominantInk: true, notationIdentity: true }) }
      ]
    });

    // When: the report is serialized for its quality sidecar.
    const serialized = serializeScoreExtractionQualityReport(report);

    // Then: fixed fields, key order, identifiers, and sidecar derivation are stable and safe.
    assert.equal(frameIdentifier(1), "frame-000001");
    assert.equal(scoreIdentifier(1), "score-0001");
    assert.equal(resolveDuplicateReason({ nearDuplicate: true, dominantInk: true, notationIdentity: true }), "near-duplicate");
    assert.equal(serialized, "{\"version\":\"score-extraction-quality-report/2\",\"qualityClaimsAllowed\":false,\"durationsMs\":{\"analysis\":12,\"deduplication\":3,\"pageComposition\":7,\"total\":22},\"frames\":[{\"frameId\":\"frame-000001\",\"disposition\":\"no-score\"},{\"frameId\":\"frame-000002\",\"disposition\":\"accepted\",\"scoreId\":\"score-0001\",\"pageNumber\":1},{\"frameId\":\"frame-000003\",\"disposition\":\"duplicate\",\"duplicateReason\":\"dominant-ink\"}],\"review\":{\"disposition\":\"raster-fallback\",\"selectedLane\":\"raster\",\"exitCode\":0,\"decisions\":[{\"pageNumber\":null,\"code\":\"RASTER_FALLBACK_SELECTED\",\"evidence\":{\"pageCount\":1}}]}}");
    assert.doesNotMatch(serialized, /(?:[A-Za-z]:[\\/]|file:\/\/)/);
    assert.equal(deriveScoreQualitySidecarPath("C:\\results\\result.pdf"), "C:\\results\\result.pdf.quality.json");
  });

  it("rejects missing, unknown, and stale review state", () => {
    // Given: malformed evidence, an unknown code, and a misleading serialized outcome.
    const missingEvidence = () => createScoreReview({
      disposition: "raster-fallback",
      rasterSafe: true,
      decisions: [
        { pageNumber: 1, code: "MUSICXML_INVALID", evidence: {} },
        REVIEW_DECISIONS[20]
      ]
    });
    const unknownCodeReport = createScoreExtractionQualityReport({
      durationsMs: { analysis: 1, deduplication: 1, pageComposition: 1, total: 3 },
      frames: []
    });
    Reflect.set(unknownCodeReport.review.decisions[0] ?? {}, "code", "UNKNOWN_CODE");
    const staleOutcome = createScoreExtractionQualityReport({
      durationsMs: { analysis: 1, deduplication: 1, pageComposition: 1, total: 3 },
      frames: []
    });
    Reflect.set(staleOutcome.review, "exitCode", 1);
    const missingReview = createScoreExtractionQualityReport({
      durationsMs: { analysis: 1, deduplication: 1, pageComposition: 1, total: 3 },
      frames: []
    });
    Reflect.deleteProperty(missingReview, "review");

    // When: each malformed state crosses the validation or serialization boundary.
    const unknownCode = () => serializeScoreExtractionQualityReport(unknownCodeReport);
    const misleadingSuccessMapping = () => serializeScoreExtractionQualityReport(staleOutcome);
    const missingV2State = () => serializeScoreExtractionQualityReport(missingReview);

    // Then: none can be persisted as a valid v2 report.
    assert.throws(missingEvidence, ScoreReviewContractError);
    assert.throws(unknownCode, ScoreReviewContractError);
    assert.throws(misleadingSuccessMapping, ScoreQualityReportContractError);
    assert.throws(missingV2State, ScoreQualityReportContractError);
  });

  it("maps every structured failure to safe raster fallback and rejects a false block", () => {
    // Given: every warning produced by the structured lane with a safe raster result.
    const structuredFailures = REVIEW_DECISIONS.filter((decision) => {
      const entry = SCORE_REVIEW_CODE_CONTRACTS.find((candidate) => candidate.code === decision.code);
      return entry?.layer === "structured" && entry.severity === "warning";
    });

    for (const failure of structuredFailures) {
      // When: the warning is resolved using the safe raster lane.
      const review = createScoreReview({
        disposition: "raster-fallback",
        rasterSafe: true,
        decisions: [failure, REVIEW_DECISIONS[20]]
      });
      const falseBlock = () => createScoreReview({ disposition: "blocked", rasterSafe: true, decisions: [failure] });

      // Then: fallback exits successfully and a false hard block is rejected.
      assert.deepEqual({ disposition: review.disposition, selectedLane: review.selectedLane, exitCode: review.exitCode }, {
        disposition: "raster-fallback", selectedLane: "raster", exitCode: 0
      });
      assert.throws(falseBlock, ScoreReviewContractError);
    }
    assert.equal(structuredFailures.length, 10);
  });

  it("canonicalizes decisions by page then code order independently of clocks and durations", () => {
    // Given: identical decisions in different orders, timestamps, and duration telemetry.
    const first = createScoreExtractionQualityReport({
      generatedAt: "2026-08-04T00:00:00.000Z",
      durationsMs: { analysis: 1, deduplication: 2, pageComposition: 3, total: 6 },
      frames: [],
      review: {
        disposition: "raster-fallback",
        rasterSafe: true,
        decisions: [REVIEW_DECISIONS[13], REVIEW_DECISIONS[7], REVIEW_DECISIONS[20]]
      }
    });
    const second = createScoreExtractionQualityReport({
      generatedAt: "2026-08-04T01:00:00.000Z",
      durationsMs: { analysis: 9, deduplication: 8, pageComposition: 7, total: 24 },
      frames: [],
      review: {
        disposition: "raster-fallback",
        rasterSafe: true,
        decisions: [REVIEW_DECISIONS[7], REVIEW_DECISIONS[20], REVIEW_DECISIONS[13]]
      }
    });

    // When: their deterministic decision sections are compared.
    const firstDecisionSection = serializeScoreExtractionQualityReport(first).slice(serializeScoreExtractionQualityReport(first).indexOf("\"review\":"));
    const secondDecisionSection = serializeScoreExtractionQualityReport(second).slice(serializeScoreExtractionQualityReport(second).indexOf("\"review\":"));

    // Then: date and duration telemetry cannot perturb the canonical decision output.
    assert.equal(firstDecisionSection, secondDecisionSection);
    assert.equal(first.qualityClaimsAllowed, false);
    assert.equal(second.qualityClaimsAllowed, false);
  });

  it("rejects a non-1-based accepted page mapping and a duplicate without a reason", () => {
    // Given: otherwise valid report inputs with invalid page and duplicate-reason values.
    // When: the contract validates them before serialization.
    const invalidPage = () => createScoreExtractionQualityReport({
      durationsMs: { analysis: 1, deduplication: 1, pageComposition: 1, total: 3 },
      frames: [{ frameId: frameIdentifier(1), disposition: "accepted", scoreId: scoreIdentifier(1), pageNumber: 0 }]
    });
    const missingDuplicateReason = () => resolveDuplicateReason({ nearDuplicate: false, dominantInk: false, notationIdentity: false });

    // Then: neither invalid state can become a persisted report.
    assert.throws(invalidPage, ScoreQualityReportContractError);
    assert.throws(missingDuplicateReason, ScoreQualityReportContractError);
  });
});
