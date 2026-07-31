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
} from "../server/score-quality-report";

describe("score extraction quality report", () => {
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
    assert.equal(serialized, "{\"version\":\"score-extraction-quality-report/1\",\"qualityClaimsAllowed\":false,\"durationsMs\":{\"analysis\":12,\"deduplication\":3,\"pageComposition\":7,\"total\":22},\"frames\":[{\"frameId\":\"frame-000001\",\"disposition\":\"no-score\"},{\"frameId\":\"frame-000002\",\"disposition\":\"accepted\",\"scoreId\":\"score-0001\",\"pageNumber\":1},{\"frameId\":\"frame-000003\",\"disposition\":\"duplicate\",\"duplicateReason\":\"dominant-ink\"}]}");
    assert.doesNotMatch(serialized, /(?:[A-Za-z]:[\\/]|file:\/\/)/);
    assert.equal(deriveScoreQualitySidecarPath("C:\\results\\result.pdf"), "C:\\results\\result.pdf.quality.json");
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
