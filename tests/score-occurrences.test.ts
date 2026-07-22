import assert from "node:assert/strict";
import { test } from "node:test";
import { orderScoreOccurrences } from "../src/shared/score-occurrences.js";
import type { DebugUniqueScore } from "../src/shared/messages.js";

test("score occurrences collapse only consecutive same-cluster entries", () => {
  // Given: a capture stream where cluster A leaves and later re-enters.
  const scores = [
    score("A", 1, 1),
    score("A", 2, 2),
    score("A", 3, 3),
    score("B", 4, 4),
    score("A", 5, 5),
    score("A", 6, 6),
    score("C", 7, 7)
  ];

  // When: occurrence order is resolved from raw score stream data.
  const occurrences = orderScoreOccurrences(scores);

  // Then: only consecutive same-cluster entries collapse.
  assert.deepEqual(occurrences.map((occurrence) => occurrence.clusterId), ["A", "B", "A", "C"]);

  const aOccurrences = occurrences.filter((occurrence) => occurrence.clusterId === "A");
  assert.equal(aOccurrences.length, 2);
  assert.notEqual(aOccurrences[0]?.occurrenceId, aOccurrences[1]?.occurrenceId);
  assert.deepEqual(aOccurrences.map((occurrence) => occurrence.repeatIndex), [1, 2]);
});

test("score occurrences preserve legacy reviewed cluster order without occurrence metadata", () => {
  // Given: legacy unique scores without occurrence metadata.
  const scores = [score("A", 1, 1), score("B", 2, 2), score("A", 3, 3)];

  // When: only legacy scoreOrder is supplied.
  const occurrences = orderScoreOccurrences(scores, { scoreOrder: ["B", "A"] });

  // Then: the fallback keeps one score per reviewed cluster in requested order.
  assert.deepEqual(occurrences.map((occurrence) => occurrence.clusterId), ["B", "A"]);
});

test("score occurrences ignore duplicate and missing occurrence order ids", () => {
  // Given: occurrence-aware scores and a stale reviewed order with duplicate and unknown ids.
  const scores = [
    score("A", 1, 1, { occurrenceId: "occ-A-1", occurrenceOrder: 1, repeatIndex: 1 }),
    score("B", 2, 2, { occurrenceId: "occ-B-1", occurrenceOrder: 2, repeatIndex: 1 }),
    score("A", 3, 3, { occurrenceId: "occ-A-2", occurrenceOrder: 3, repeatIndex: 2 })
  ];

  // When: occurrenceOrder contains duplicates and a missing id.
  const occurrences = orderScoreOccurrences(scores, {
    occurrenceOrder: ["missing", "occ-A-2", "occ-A-2", "occ-B-1", "occ-A-1"]
  });

  // Then: valid ids appear once, in requested order.
  assert.deepEqual(occurrences.map((occurrence) => occurrence.occurrenceId), ["occ-A-2", "occ-B-1", "occ-A-1"]);
  assert.deepEqual(occurrences.map((occurrence) => occurrence.clusterId), ["A", "B", "A"]);
});

test("score occurrences handle empty streams and all-same clusters", () => {
  // Given: no candidate scores.
  const emptyScores: DebugUniqueScore[] = [];

  // When: occurrence order is resolved.
  const emptyOccurrences = orderScoreOccurrences(emptyScores);

  // Then: no phantom occurrence is created.
  assert.deepEqual(emptyOccurrences, []);

  // Given: a stream containing only consecutive copies of the same cluster without occurrence ids.
  const allSameScores = [score("A", 1, 1), score("A", 2, 2), score("A", 3, 3)];

  // When: occurrence order is resolved.
  const allSameOccurrences = orderScoreOccurrences(allSameScores);

  // Then: the stream collapses to one generated occurrence.
  assert.deepEqual(allSameOccurrences.map((occurrence) => occurrence.clusterId), ["A"]);
  assert.equal(allSameOccurrences[0]?.occurrenceId, "session-1:A:1");
  assert.equal(allSameOccurrences[0]?.repeatIndex, 1);
});

function score(
  clusterId: string,
  firstSeenSec: number,
  order: number,
  occurrence?: OccurrenceFixtureFields
): DebugUniqueScore {
  return {
    id: `score-${clusterId}-${order}`,
    sessionId: "session-1",
    clusterId,
    source: {
      videoId: "video-1",
      url: "https://www.youtube.com/watch?v=video-1",
      firstSeenSec,
      lastSeenSec: firstSeenSec
    },
    image: {
      imageBlobId: `blob-${clusterId}-${order}`,
      dataUrl: `data:image/png;base64,${Buffer.from(`${clusterId}-${order}`).toString("base64")}`,
      width: 100,
      height: 40
    },
    qualityScore: 0.9,
    order,
    ...occurrence
  };
}

type OccurrenceFixtureFields = {
  readonly occurrenceId?: string;
  readonly occurrenceOrder?: number;
  readonly repeatIndex?: number;
};
