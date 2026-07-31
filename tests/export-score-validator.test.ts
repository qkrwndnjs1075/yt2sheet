import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkScorePages } from "../src/background/score-export-download.js";
import { LocalExportScoreInspector, validateExportScores, type ScoreInspectionResult, type ScoreInspector } from "../src/background/export-score-validator.js";
import type { ExportScoreImageCleaner } from "../src/background/export-score-image-cleaner.js";
import type { DebugUniqueScore } from "../src/shared/messages.js";

const VALID: ScoreInspectionResult = { status: "valid", confidence: 0.95, reason: "clean score", source: "local" };
const CONTAMINATED: ScoreInspectionResult = { status: "contaminated", confidence: 0.96, reason: "overlay covers notation", source: "local" };
const LOCAL_VALID: ScoreInspectionResult = { status: "valid", confidence: 0.82, reason: "local clean score", source: "local" };
const LOCAL_CONTAMINATED: ScoreInspectionResult = { status: "contaminated", confidence: 0.9, reason: "local overlay", source: "local" };

test("export validation preserves repeated occurrence scores when occurrence order is supplied", async () => {
  // Given: repeated A occurrences with distinct occurrence identities.
  const firstA = occurrenceScore("score-A1", "A", 1, "occ-A-1", 1, 1);
  const firstB = occurrenceScore("score-B1", "B", 2, "occ-B-1", 2, 1);
  const secondA = occurrenceScore("score-A2", "A", 3, "occ-A-2", 3, 2);
  const firstC = occurrenceScore("score-C1", "C", 4, "occ-C-1", 4, 1);
  const options = {
    occurrenceOrder: ["occ-A-1", "occ-B-1", "occ-A-2", "occ-C-1"],
    localInspector: inspector({ "score-A1": VALID, "score-B1": VALID, "score-A2": VALID, "score-C1": VALID })
  };

  // When: validation uses occurrenceOrder instead of legacy cluster order.
  const report = await validateExportScores([firstA, firstB, secondA, firstC], options);

  // Then: both A occurrences remain in reviewed order.
  assert.deepEqual(report.scores.map((item) => item.id), ["score-A1", "score-B1", "score-A2", "score-C1"]);
  assert.deepEqual(report.decisions.map((decision) => decision.occurrenceId), ["occ-A-1", "occ-B-1", "occ-A-2", "occ-C-1"]);
  assert.deepEqual(report.decisions.map((decision) => decision.occurrenceOrder), [1, 2, 3, 4]);
});

test("export validation keeps legacy score order as one score per cluster fallback", async () => {
  // Given: legacy scores without occurrence metadata and a repeated A cluster.
  const firstA = score("score-A1", "A", 1);
  const firstB = score("score-B1", "B", 2);
  const secondA = score("score-A2", "A", 3);

  // When: only legacy scoreOrder is provided.
  const report = await validateExportScores([firstA, firstB, secondA], {
    scoreOrder: ["B", "A"],
    localInspector: inspector({ "score-A1": VALID, "score-B1": VALID, "score-A2": VALID })
  });

  // Then: the legacy fallback returns one score per cluster in requested order.
  assert.deepEqual(report.scores.map((item) => item.id), ["score-B1", "score-A1"]);
  assert.deepEqual(report.scores.map((item) => item.clusterId), ["B", "A"]);
});

test("export validation replaces only the contaminated occurrence when a clean same-occurrence candidate exists", async () => {
  // Given: A2 is contaminated, while A1 is a clean sibling occurrence of the same cluster.
  const firstA = occurrenceScore("score-A1", "A", 1, "occ-A-1", 1, 1);
  const firstB = occurrenceScore("score-B1", "B", 2, "occ-B-1", 2, 1);
  const secondA = occurrenceScore("score-A2-bad", "A", 3, "occ-A-2", 3, 2);
  const firstC = occurrenceScore("score-C1", "C", 4, "occ-C-1", 4, 1);
  const wrongOccurrenceCandidate = occurrenceScore("score-A1-clean-candidate", "A", 7, "occ-A-1", 1, 1);
  const matchingOccurrenceCandidate = occurrenceScore("score-A2-clean-candidate", "A", 6, "occ-A-2", 3, 2);
  const options = {
    occurrenceOrder: ["occ-A-1", "occ-B-1", "occ-A-2", "occ-C-1"],
    candidates: [wrongOccurrenceCandidate, matchingOccurrenceCandidate],
    localInspector: inspector({
      "score-A1": VALID,
      "score-B1": VALID,
      "score-A2-bad": CONTAMINATED,
      "score-C1": VALID,
      "score-A1-clean-candidate": VALID,
      "score-A2-clean-candidate": VALID
    })
  };

  // When: validation searches same-cluster replacement candidates.
  const report = await validateExportScores([firstA, firstB, secondA, firstC], options);

  // Then: A2 is replaced with its matching occurrence candidate and A1 remains untouched.
  assert.deepEqual(report.scores.map((item) => item.id), ["score-A1", "score-B1", "score-A2-clean-candidate", "score-C1"]);
  assert.deepEqual(report.decisions.map((decision) => ({
    action: decision.action,
    occurrenceId: decision.occurrenceId,
    scoreId: decision.scoreId,
    replacementScoreId: decision.replacementScoreId
  })), [
    { action: "kept", occurrenceId: "occ-A-1", scoreId: "score-A1", replacementScoreId: undefined },
    { action: "kept", occurrenceId: "occ-B-1", scoreId: "score-B1", replacementScoreId: undefined },
    { action: "replaced", occurrenceId: "occ-A-2", scoreId: "score-A2-bad", replacementScoreId: "score-A2-clean-candidate" },
    { action: "kept", occurrenceId: "occ-C-1", scoreId: "score-C1", replacementScoreId: undefined }
  ]);
});

test("export validation preserves occurrence identity when replacement candidate has no occurrence metadata", async () => {
  // Given: A2 is contaminated and only a cluster-level clean candidate is available.
  const firstA = occurrenceScore("score-A1", "A", 1, "occ-A-1", 1, 1);
  const firstB = occurrenceScore("score-B1", "B", 2, "occ-B-1", 2, 1);
  const secondA = occurrenceScore("score-A2-bad", "A", 3, "occ-A-2", 3, 2);
  const firstC = occurrenceScore("score-C1", "C", 4, "occ-C-1", 4, 1);
  const clusterLevelCandidate = score("score-A-clean-cluster-candidate", "A", 8);
  const options = {
    occurrenceOrder: ["occ-A-1", "occ-B-1", "occ-A-2", "occ-C-1"],
    candidates: [clusterLevelCandidate],
    localInspector: inspector({
      "score-A1": VALID,
      "score-B1": VALID,
      "score-A2-bad": CONTAMINATED,
      "score-C1": VALID,
      "score-A-clean-cluster-candidate": VALID
    })
  };

  // When: validation replaces A2 with the metadata-free clean candidate.
  const report = await validateExportScores([firstA, firstB, secondA, firstC], options);
  const replacementScore = report.scores[2];
  const pageClusters = chunkScorePages(report.scores).flat().map((system) => system.clusterId);

  // Then: the replacement image/id is used while A2's occurrence identity remains export-orderable.
  assert.deepEqual(report.decisions.map((decision) => ({
    action: decision.action,
    occurrenceId: decision.occurrenceId,
    scoreId: decision.scoreId,
    replacementScoreId: decision.replacementScoreId
  })), [
    { action: "kept", occurrenceId: "occ-A-1", scoreId: "score-A1", replacementScoreId: undefined },
    { action: "kept", occurrenceId: "occ-B-1", scoreId: "score-B1", replacementScoreId: undefined },
    { action: "replaced", occurrenceId: "occ-A-2", scoreId: "score-A2-bad", replacementScoreId: "score-A-clean-cluster-candidate" },
    { action: "kept", occurrenceId: "occ-C-1", scoreId: "score-C1", replacementScoreId: undefined }
  ]);
  assert.deepEqual(report.scores.map((item) => item.clusterId), ["A", "B", "A", "C"]);
  assert.equal(replacementScore?.id, "score-A-clean-cluster-candidate");
  assert.equal(replacementScore?.image.dataUrl, clusterLevelCandidate.image.dataUrl);
  assert.equal(replacementScore?.occurrenceId, "occ-A-2");
  assert.equal(replacementScore?.occurrenceOrder, 3);
  assert.equal(replacementScore?.repeatIndex, 2);
  assert.equal(replacementScore?.repeatCount, 2);
  assert.deepEqual(pageClusters, ["A", "B", "A", "C"]);
});

test("export validation excludes only the contaminated occurrence when no clean same-cluster candidate exists", async () => {
  // Given: A2 is contaminated and no replacement has readable image data.
  const firstA = occurrenceScore("score-A1", "A", 1, "occ-A-1", 1, 1);
  const firstB = occurrenceScore("score-B1", "B", 2, "occ-B-1", 2, 1);
  const secondA = occurrenceScore("score-A2-bad", "A", 3, "occ-A-2", 3, 2);
  const firstC = occurrenceScore("score-C1", "C", 4, "occ-C-1", 4, 1);
  const missingImageCandidate = occurrenceScore("score-A2-missing-image", "A", 5, "occ-A-2", 3, 2, false);
  const options = {
    occurrenceOrder: ["occ-A-1", "occ-B-1", "occ-A-2", "occ-C-1"],
    candidates: [missingImageCandidate],
    localInspector: inspector({
      "score-A1": VALID,
      "score-B1": VALID,
      "score-A2-bad": CONTAMINATED,
      "score-C1": VALID
    })
  };

  // When: validation fails closed for A2.
  const report = await validateExportScores([firstA, firstB, secondA, firstC], options);

  // Then: only A2 is excluded; A1, B1, and C1 remain.
  assert.deepEqual(report.scores.map((item) => item.id), ["score-A1", "score-B1", "score-C1"]);
  assert.deepEqual(report.decisions.map((decision) => ({
    action: decision.action,
    occurrenceId: decision.occurrenceId,
    scoreId: decision.scoreId
  })), [
    { action: "kept", occurrenceId: "occ-A-1", scoreId: "score-A1" },
    { action: "kept", occurrenceId: "occ-B-1", scoreId: "score-B1" },
    { action: "excluded", occurrenceId: "occ-A-2", scoreId: "score-A2-bad" },
    { action: "kept", occurrenceId: "occ-C-1", scoreId: "score-C1" }
  ]);
  assert.equal(report.summary.excludedCount, 1);
});

test("export validation replaces a locally detected contaminated capture with a clean same-cluster candidate", async () => {
  const primary = score("score-A-bad", "A", 1);
  const replacement = score("score-A-clean", "A", 2);
  const other = score("score-B", "B", 3);
  const report = await validateExportScores([primary, other], {
    scoreOrder: ["A", "B"],
    candidates: [primary, replacement, other],
    localInspector: inspector({ "score-A-bad": CONTAMINATED, "score-A-clean": VALID, "score-B": VALID })
  });

  assert.deepEqual(report.scores.map((item) => item.id), ["score-A-clean", "score-B"]);
  assert.equal(report.summary.replacedCount, 1);
  assert.equal(report.summary.excludedCount, 0);
  assert.deepEqual(report.decisions.map((decision) => ({
    action: decision.action,
    scoreId: decision.scoreId,
    replacementScoreId: decision.replacementScoreId
  })), [
    { action: "replaced", scoreId: "score-A-bad", replacementScoreId: "score-A-clean" },
    { action: "kept", scoreId: "score-B", replacementScoreId: undefined }
  ]);
});

test("export validation excludes a contaminated capture when no clean replacement exists", async () => {
  const primary = score("score-A-bad", "A", 1);
  const report = await validateExportScores([primary], {
    scoreOrder: ["A"],
    candidates: [primary],
    localInspector: inspector({ "score-A-bad": CONTAMINATED })
  });

  assert.deepEqual(report.scores, []);
  assert.equal(report.summary.excludedCount, 1);
});

test("export validation fails closed for low-confidence contaminated results", async () => {
  const primary = score("score-A-low-confidence-bad", "A", 1);
  const report = await validateExportScores([primary], {
    scoreOrder: ["A"],
    localInspector: inspector({
      "score-A-low-confidence-bad": { status: "contaminated", confidence: 0.2, reason: "weak overlay signal", source: "local" }
    })
  });

  assert.deepEqual(report.scores, []);
  assert.equal(report.summary.excludedCount, 1);
});

test("export validation keeps clean captures unchanged", async () => {
  const first = score("score-A", "A", 1);
  const second = score("score-B", "B", 2);
  const report = await validateExportScores([first, second], {
    scoreOrder: ["B", "A"],
    localInspector: inspector({ "score-A": VALID, "score-B": VALID })
  });

  assert.deepEqual(report.scores.map((item) => item.id), ["score-B", "score-A"]);
  assert.equal(report.summary.keptCount, 2);
  assert.equal(report.summary.replacedCount, 0);
  assert.equal(report.summary.excludedCount, 0);
});

test("export validation inspects a cleaned derivative without mutating the captured score or occurrence identity", async () => {
  const original = occurrenceScore("score-A", "A", 1, "occ-A-1", 1, 1);
  const candidate = score("score-A-candidate", "A", 2);
  const originalDataUrl = original.image.dataUrl;
  const inspectedDataUrls: Array<string | undefined> = [];
  const cleaner: ExportScoreImageCleaner = {
    async clean(scoreToClean, candidates) {
      assert.deepEqual(candidates.map((item) => item.id), ["score-A-candidate", "score-A"]);
      return {
        ...scoreToClean,
        image: {
          ...scoreToClean.image,
          dataUrl: "data:image/png;base64,CLEANED",
          width: 80,
          height: 30
        }
      };
    }
  };

  const report = await validateExportScores([original], {
    occurrenceOrder: ["occ-A-1"],
    candidates: [candidate],
    imageCleaner: cleaner,
    localInspector: {
      async inspect(item) {
        inspectedDataUrls.push(item.image.dataUrl);
        return LOCAL_VALID;
      }
    }
  });

  assert.deepEqual(inspectedDataUrls, ["data:image/png;base64,CLEANED"]);
  assert.equal(report.scores[0]?.occurrenceId, "occ-A-1");
  assert.equal(report.scores[0]?.occurrenceOrder, 1);
  assert.equal(report.scores[0]?.image.width, 80);
  assert.equal(original.image.dataUrl, originalDataUrl);
  assert.equal(original.image.width, 100);
});

test("export validation cleans a replacement candidate before inspecting and exporting it", async () => {
  // Given: a contaminated selection whose replacement also requires deterministic image cleanup.
  const original = score("score-A-bad", "A", 1);
  const replacement = score("score-A-replacement", "A", 2);
  const cleanedIds: string[] = [];
  const inspectedDataUrls: Array<string | undefined> = [];
  const cleaner: ExportScoreImageCleaner = {
    async clean(item) {
      cleanedIds.push(item.id);
      return {
        ...item,
        image: { ...item.image, dataUrl: `${item.image.dataUrl}-CLEANED` }
      };
    }
  };

  // When: validation rejects the selected image and searches for a replacement.
  const report = await validateExportScores([original], {
    candidates: [replacement],
    imageCleaner: cleaner,
    localInspector: {
      async inspect(item) {
        inspectedDataUrls.push(item.image.dataUrl);
        return item.id === original.id ? LOCAL_CONTAMINATED : LOCAL_VALID;
      }
    }
  });

  // Then: both paths use cleaned derivatives and only the cleaned replacement reaches export.
  assert.deepEqual(cleanedIds, [original.id, replacement.id]);
  assert.deepEqual(inspectedDataUrls, [
    `${original.image.dataUrl}-CLEANED`,
    `${replacement.image.dataUrl}-CLEANED`
  ]);
  assert.equal(report.scores[0]?.image.dataUrl, `${replacement.image.dataUrl}-CLEANED`);
});

test("export validation accepts a full-width compact score even when it is shorter than the session median", async () => {
  const first = score("score-A", "A", 1);
  const compact = score("score-B-compact-tab", "B", 2);
  const third = score("score-C", "C", 3);
  first.image.width = 1322;
  first.image.height = 347;
  compact.image.width = 1322;
  compact.image.height = 222;
  third.image.width = 1322;
  third.image.height = 347;
  const inspected: string[] = [];

  const report = await validateExportScores([first, compact, third], {
    scoreOrder: ["A", "B", "C"],
    localInspector: {
      inspect: async (item) => {
        inspected.push(item.id);
        return VALID;
      }
    }
  });

  assert.deepEqual(report.scores.map((item) => item.id), ["score-A", "score-B-compact-tab", "score-C"]);
  assert.deepEqual(inspected, ["score-A", "score-B-compact-tab", "score-C"]);
  assert.equal(report.decisions[1]?.action, "kept");
});

test("export validation still rejects a clearly width-truncated geometry outlier before local inspection", async () => {
  const first = score("score-A", "A", 1);
  const clipped = score("score-B-clipped", "B", 2);
  const third = score("score-C", "C", 3);
  first.image.width = 1322;
  first.image.height = 347;
  clipped.image.width = 500;
  clipped.image.height = 222;
  third.image.width = 1322;
  third.image.height = 347;
  const inspected: string[] = [];

  const report = await validateExportScores([first, clipped, third], {
    scoreOrder: ["A", "B", "C"],
    localInspector: {
      inspect: async (item) => {
        inspected.push(item.id);
        return VALID;
      }
    }
  });

  assert.deepEqual(report.scores.map((item) => item.id), ["score-A", "score-C"]);
  assert.deepEqual(inspected, ["score-A", "score-C"]);
  assert.equal(report.decisions[1]?.action, "excluded");
  assert.match(report.decisions[1]?.reason ?? "", /incomplete image geometry/i);
  assert.equal(report.decisions[1]?.validator, "local");
});

test("local export validation fails closed when canvas context is unavailable", async () => {
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const originalOffscreenCanvas = globalThis.OffscreenCanvas;

  try {
    globalThis.createImageBitmap = (async () => ({
      width: 10,
      height: 10,
      close() {}
    })) as typeof createImageBitmap;
    Object.defineProperty(globalThis, "OffscreenCanvas", {
      configurable: true,
      value: class {
      constructor(_width: number, _height: number) {}
      getContext(): null {
        return null;
      }
      }
    });

    const result = await new LocalExportScoreInspector().inspect(score("score-A", "A", 1));

    assert.equal(result.status, "contaminated");
    assert.equal(result.source, "local");
    assert.match(result.reason, /canvas unavailable/);
  } finally {
    globalThis.createImageBitmap = originalCreateImageBitmap;
    Object.defineProperty(globalThis, "OffscreenCanvas", {
      configurable: true,
      value: originalOffscreenCanvas
    });
  }
});

function inspector(results: Record<string, ScoreInspectionResult>): ScoreInspector {
  return {
    async inspect(score) {
      return results[score.id] ?? VALID;
    }
  };
}

function score(id: string, clusterId: string, order: number): DebugUniqueScore {
  return {
    id,
    sessionId: "session_1",
    clusterId,
    source: {
      videoId: "video_1",
      url: "https://www.youtube.com/watch?v=video_1",
      firstSeenSec: order,
      lastSeenSec: order,
      seenCount: 1
    },
    image: {
      imageBlobId: `${id}-blob`,
      dataUrl: `data:image/png;base64,${Buffer.from(id).toString("base64")}`,
      width: 100,
      height: 40
    },
    qualityScore: order,
    order
  };
}

function occurrenceScore(
  id: string,
  clusterId: string,
  order: number,
  occurrenceId: string,
  occurrenceOrder: number,
  repeatIndex: number,
  hasImage = true
): DebugUniqueScore {
  return {
    ...score(id, clusterId, order),
    image: {
      imageBlobId: `${id}-blob`,
      dataUrl: hasImage ? `data:image/png;base64,${Buffer.from(id).toString("base64")}` : undefined,
      width: 100,
      height: 40
    },
    occurrenceId,
    occurrenceOrder,
    repeatIndex,
    repeatCount: clusterId === "A" ? 2 : 1
  };
}
