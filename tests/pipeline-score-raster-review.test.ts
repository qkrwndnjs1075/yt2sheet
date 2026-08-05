import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  RASTER_REVIEW_POLICY,
  RASTER_REVIEW_POLICY_DIGEST,
  RasterReviewInputError,
  calibrateRasterReviewPolicy,
  createRasterReviewSession,
  reviewRasterSource
} from "../pipeline/score-raster-review";
import { createScoreExtractionQualityReport, ScoreQualityReportContractError } from "../pipeline/score-quality-report";

const EPSILON = 0.000_001;

describe("observable raster source-fidelity review", () => {
  it("applies exact hard and warning boundaries", () => {
    // Given: measurements immediately below, at, and above every locked threshold.
    const cases = [
      { patch: { boundaryConnectedNotationWidthPx: 1.999 }, expected: [] },
      { patch: { boundaryConnectedNotationWidthPx: 2 }, expected: ["RASTER_CROP_CLIPPED"] },
      { patch: { boundaryConnectedNotationWidthPx: 2.001 }, expected: ["RASTER_CROP_CLIPPED"] },
      { patch: { boundaryComponentCrossingPx: 9.999 }, expected: [] },
      { patch: { boundaryComponentCrossingPx: 10 }, expected: ["RASTER_CROP_CLIPPED"] },
      { patch: { boundaryComponentCrossingPx: 10.001 }, expected: ["RASTER_CROP_CLIPPED"] },
      { patch: { renderedStaffGapPx: 6 - EPSILON }, expected: ["RASTER_UNREADABLE"] },
      { patch: { renderedStaffGapPx: 6 }, expected: [] },
      { patch: { renderedStaffGapPx: 6 + EPSILON }, expected: [] },
      { patch: { inkContrast: 12 - EPSILON }, expected: ["RASTER_UNREADABLE"] },
      { patch: { inkContrast: 12 }, expected: ["RASTER_LOW_CONTRAST"] },
      { patch: { inkContrast: 12 + EPSILON }, expected: ["RASTER_LOW_CONTRAST"] },
      { patch: { inkContrast: 23 - EPSILON }, expected: ["RASTER_LOW_CONTRAST"] },
      { patch: { inkContrast: 23 }, expected: ["RASTER_LOW_CONTRAST"] },
      { patch: { inkContrast: 23 + EPSILON }, expected: [] },
      { patch: { nonNotationCoverage: 0.01 - EPSILON }, expected: [] },
      { patch: { nonNotationCoverage: 0.01 }, expected: [] },
      { patch: { nonNotationCoverage: 0.01 + EPSILON }, expected: [] },
      { patch: { nonNotationCoverage: 0.05 - EPSILON }, expected: [] },
      { patch: { nonNotationCoverage: 0.05 }, expected: [] },
      { patch: { nonNotationCoverage: 0.05 + EPSILON }, expected: ["RASTER_CONTAMINATED"] }
    ] as const;

    // When: each independently varied observation is reviewed.
    // Then: only the exact specified finding codes appear.
    for (const testCase of cases) {
      const result = reviewRasterSource(input({ pages: [page(testCase.patch)] }));
      assert.deepEqual(result.findings.map((finding) => finding.code), testCase.expected);
      if ("nonNotationCoverage" in testCase.patch && testCase.patch.nonNotationCoverage >= 0.01 && testCase.patch.nonNotationCoverage <= 0.05) {
        assert.equal(result.pages[0]?.contamination, "warning");
        assert.equal(result.status, "warning");
      }
    }
  });

  it("treats titles, standard/grand staves, and TAB identically when observable metrics are safe", () => {
    // Given: delayed-title and notation-kind labels with the same safe measurements.
    const pages = [
      page({ pageNumber: 1, notationKind: "standard", delayedTitle: true }),
      page({ pageNumber: 2, notationKind: "grand-staff" }),
      page({ pageNumber: 3, notationKind: "tab" })
    ];

    // When: the pages are reviewed without musical-semantic inference.
    const result = reviewRasterSource(input({
      pages,
      acceptedScores: pages.map((entry, index) => ({ frameNumber: index + 2, scoreNumber: index + 1, pageNumber: entry.pageNumber })),
      pageLineage: pages.map((entry, index) => ({ pageNumber: entry.pageNumber, scoreNumbers: [index + 1] }))
    }));

    // Then: no hard or warning finding is invented from the labels.
    assert.equal(result.status, "pass");
    assert.equal(result.omrEligible, true);
    assert.deepEqual(result.findings, []);
  });

  it("derives the crop edge band from half a staff gap with a two-pixel minimum", () => {
    // Given: pages whose half-gap rounds below, to, and above the minimum edge band.
    const pages = [page({ pageNumber: 1, staffGapPx: 2 }), page({ pageNumber: 2, staffGapPx: 5 }), page({ pageNumber: 3, staffGapPx: 8 })];

    // When: the observable edge bands are derived.
    const result = reviewRasterSource(input({
      pages,
      acceptedScores: pages.map((entry, index) => ({ frameNumber: index + 1, scoreNumber: index + 1, pageNumber: entry.pageNumber })),
      pageLineage: pages.map((entry, index) => ({ pageNumber: entry.pageNumber, scoreNumbers: [index + 1] }))
    }));

    // Then: max(2px, round(staffGap/2)) is applied exactly.
    assert.deepEqual(result.pages.map((entry) => entry.edgeBandPx), [2, 3, 4]);
  });

  it("distinguishes genuine notation from unresolved duplicate ambiguity at both epsilon boundaries", () => {
    // Given: legacy rules did not resolve three duplicate comparisons.
    const cases = [
      { patch: { notationOverlap: 0.6 - EPSILON, staffGapDelta: 0.08 }, warning: false },
      { patch: { notationOverlap: 0.6, staffGapDelta: 0.08 }, warning: true },
      { patch: { notationOverlap: 0.6 + EPSILON, staffGapDelta: 0.08 }, warning: true },
      { patch: { notationOverlap: 0.6, staffGapDelta: 0.08 - EPSILON }, warning: true },
      { patch: { notationOverlap: 0.6, staffGapDelta: 0.08 + EPSILON }, warning: false },
      { patch: { notationOverlap: 0.8, staffGapDelta: 0.01, resolvedByLegacy: true }, warning: false }
    ];

    // When: each overlap and staff-gap boundary is reviewed independently.
    const results = cases.map((testCase) => reviewRasterSource(input({ duplicates: [duplicate(testCase.patch)] })));

    // Then: at/above overlap and at/below staff-gap warn only when legacy rules remain unresolved.
    assert.deepEqual(results.map((result) => result.findings.some((finding) => finding.code === "RASTER_DUPLICATE_AMBIGUOUS")), cases.map((testCase) => testCase.warning));
  });

  it("blocks invalid accepted frame, score, or page lineage", () => {
    // Given: frame, score, and page order violations considered independently.
    const cases = [
      [{ frameNumber: 2, scoreNumber: 1, pageNumber: 1 }, { frameNumber: 1, scoreNumber: 2, pageNumber: 1 }],
      [{ frameNumber: 1, scoreNumber: 2, pageNumber: 1 }, { frameNumber: 2, scoreNumber: 1, pageNumber: 1 }],
      [{ frameNumber: 2, scoreNumber: 1, pageNumber: 2 }, { frameNumber: 3, scoreNumber: 2, pageNumber: 1 }]
    ];

    // When: each invalid lineage is reviewed.
    const results = cases.map((acceptedScores) => reviewRasterSource(input({ acceptedScores })));

    // Then: every invalid ordering blocks before OMR and page regression retains exact evidence.
    for (const result of results) {
      assert.equal(result.status, "blocked");
      assert.equal(result.omrEligible, false);
      assert.equal(result.findings[0]?.code, "RASTER_LINEAGE_INVALID");
    }
    assert.deepEqual(results[2]?.findings[0], {
      pageNumber: 1,
      code: "RASTER_LINEAGE_INVALID",
      severity: "hard",
      evidence: { expectedPageNumber: 2, actualPageNumber: 1 }
    });
  });

  it("blocks reordered or missing page observation lineage", () => {
    // Given: a page observation sequence that skips page one.
    const pages = [page({ pageNumber: 2 })];

    // When: page lineage is compared to the accepted-score mapping.
    const result = reviewRasterSource(input({ pages }));

    // Then: the page-order mismatch blocks with the observed page number.
    assert.deepEqual(result.findings[0], {
      pageNumber: 2,
      code: "RASTER_LINEAGE_INVALID",
      severity: "hard",
      evidence: { expectedPageNumber: 1, actualPageNumber: 2 }
    });
  });

  it("rejects malformed metrics and stale config digests", () => {
    // Given: non-finite/range-invalid metrics and a digest not matching the supplied policy.
    const malformed = input({ pages: [page({ inkContrast: Number.NaN })] });
    const stale = { ...input(), configDigest: "0".repeat(64) };

    // When/Then: both untrusted boundaries reject instead of reporting heuristic success.
    assert.throws(() => reviewRasterSource(malformed), RasterReviewInputError);
    assert.throws(() => reviewRasterSource(stale), RasterReviewInputError);
  });

  it("rejects a caller-authored policy even when its digest is self-consistent", () => {
    // Given: a forged review-time policy that lowers contrast gates to zero and hashes itself.
    const policy = { ...RASTER_REVIEW_POLICY, inkContrastHard: 0, inkContrastWarningMax: 0 };
    const configDigest = createHash("sha256").update(JSON.stringify(policy)).digest("hex");
    const forged = { ...input({ pages: [page({ inkContrast: 1 })] }), policy, configDigest };

    // When/Then: the public review boundary rejects policy authority not issued by calibration.
    assert.throws(() => reviewRasterSource(forged), RasterReviewInputError);
  });

  it("allows threshold changes only on calibration before test execution with a recorded digest", () => {
    // Given: the locked policy digest and a calibration-only threshold change.
    const session = createRasterReviewSession();
    const calibrated = calibrateRasterReviewPolicy({
      session,
      split: "calibration",
      baseConfigDigest: RASTER_REVIEW_POLICY_DIGEST,
      thresholds: { inkContrastWarningMax: 22 }
    });

    // When/Then: the change gets a new digest, while test/stale/post-test requests reject.
    assert.notEqual(calibrated.configDigest, RASTER_REVIEW_POLICY_DIGEST);
    assert.equal(calibrated.policy.inkContrastWarningMax, 22);
    assert.equal(Reflect.set(calibrated.policy, "inkContrastHard", 0), false);
    const calibratedResult = reviewRasterSource({
      ...input({ pages: [page({ inkContrast: 23 })] }),
      session,
      configDigest: calibrated.configDigest,
      calibrationProvenance: calibrated.provenance
    });
    assert.equal(calibratedResult.status, "pass");
    assert.throws(() => reviewRasterSource({
      ...input(),
      session,
      configDigest: calibrated.configDigest,
      calibrationProvenance: { configDigest: calibrated.configDigest }
    }), RasterReviewInputError);
    for (const invalid of [
      { session: createRasterReviewSession(), split: "test", baseConfigDigest: RASTER_REVIEW_POLICY_DIGEST, thresholds: { inkContrastWarningMax: 22 } },
      { session: createRasterReviewSession(), split: "calibration", baseConfigDigest: "f".repeat(64), thresholds: { inkContrastWarningMax: 22 } }
    ]) assert.throws(() => calibrateRasterReviewPolicy(invalid), RasterReviewInputError);
  });

  it("rejects calibration after review because review irreversibly closes the session", () => {
    // Given: the locked reviewer has already started the test/review phase.
    const session = createRasterReviewSession();
    reviewRasterSource(input({ session }));

    // When/Then: the module-owned session phase cannot be reopened by a calibration request.
    assert.throws(() => calibrateRasterReviewPolicy({
      session,
      split: "calibration",
      baseConfigDigest: RASTER_REVIEW_POLICY_DIGEST,
      thresholds: { inkContrastWarningMax: 22 }
    }), RasterReviewInputError);
  });

  it("drives checked-in happy and failure observations with exact metrics", async () => {
    // Given: source-controlled clean and compound-failure fixture observations.
    const fixtureDirectory = join(process.cwd(), "tests", "fixtures", "score-raster-review");
    const clean = await fixture(fixtureDirectory, "clean.json");
    const happy = await fixture(fixtureDirectory, "happy.json");
    const failure = await fixture(fixtureDirectory, "failure.json");

    // When: the real JSON boundary drives the reviewer.
    const cleanResult = reviewRasterSource(clean);
    const happyResult = reviewRasterSource(happy);
    const failureResult = reviewRasterSource(failure);

    // Then: readable low contrast warns, while exact clip/unreadable/contamination/lineage metrics block.
    assert.equal(cleanResult.status, "pass");
    assert.equal(happyResult.status, "warning");
    assert.deepEqual(happyResult.findings.map((finding) => finding.code), ["RASTER_LOW_CONTRAST"]);
    assert.equal(happyResult.pages[0]?.contamination, "warning");
    assert.equal(failureResult.status, "blocked");
    assert.deepEqual(failureResult.findings.map((finding) => finding.code), [
      "RASTER_LINEAGE_INVALID",
      "RASTER_CROP_CLIPPED",
      "RASTER_UNREADABLE",
      "RASTER_CONTAMINATED"
    ]);
    assert.deepEqual(failureResult.pages[0], { pageNumber: 1, edgeBandPx: 6, boundaryInkRatio: 0.002, contamination: "hard" });
  });
});

describe("accepted-score report lineage", () => {
  it("rejects a page regression that the baseline accepted", () => {
    // Given: sequential accepted frames/scores whose page mapping regresses from 2 to 1.
    const frames = [
      { frameId: "frame-000001" as const, disposition: "accepted" as const, scoreId: "score-0001" as const, pageNumber: 2 },
      { frameId: "frame-000002" as const, disposition: "accepted" as const, scoreId: "score-0002" as const, pageNumber: 1 }
    ];

    // When/Then: report creation blocks the non-monotonic accepted-score/page lineage.
    assert.throws(() => createScoreExtractionQualityReport({ durationsMs: durations(), frames }), ScoreQualityReportContractError);
  });
});

function input(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    session: createRasterReviewSession(),
    configDigest: RASTER_REVIEW_POLICY_DIGEST,
    pages: [page()],
    acceptedScores: [{ frameNumber: 1, scoreNumber: 1, pageNumber: 1 }],
    pageLineage: [{ pageNumber: 1, scoreNumbers: [1] }],
    duplicates: [],
    ...overrides
  };
}

function page(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    pageNumber: 1,
    contentWidthPx: 1000,
    staffGapPx: 10,
    boundaryConnectedNotationWidthPx: 0,
    boundaryComponentCrossingPx: 0,
    renderedStaffGapPx: 8,
    inkContrast: 24,
    nonNotationCoverage: 0,
    notationKind: "standard",
    delayedTitle: false,
    ...overrides
  };
}

function duplicate(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    leftScoreNumber: 1,
    rightScoreNumber: 2,
    notationOverlap: 0,
    staffGapDelta: 1,
    resolvedByLegacy: false,
    ...overrides
  };
}

async function fixture(directory: string, name: string): Promise<unknown> {
  const value: unknown = JSON.parse(await readFile(join(directory, name), "utf8"));
  if (typeof value === "object" && value !== null) {
    Reflect.set(value, "session", createRasterReviewSession());
    Reflect.set(value, "configDigest", RASTER_REVIEW_POLICY_DIGEST);
  }
  return value;
}

function durations() {
  return { analysis: 0, deduplication: 0, pageComposition: 0, total: 0 };
}

assert.equal(RASTER_REVIEW_POLICY.boundaryInkRatioHard, 0.002);
