import assert from "node:assert/strict";
import { test } from "node:test";
import { EndCandidateGate } from "../src/offscreen/identity/end-candidate-gate.js";
import { measureEndCandidate } from "../src/offscreen/identity/end-candidate-metrics.js";
import { ScoreClusterer, type ClusterInput } from "../src/offscreen/identity/score-clusterer.js";
import type { NormalizedScoreImage, ScoreFingerprint } from "../src/shared/fingerprint-types.js";
import type { RoiSample } from "../src/shared/roi-types.js";

test("end candidate gate holds one near-end different sample before export", () => {
  const clusterer = new ScoreClusterer();
  const gate = new EndCandidateGate(clusterer);

  gate.handle(gateInput("a1", fingerprint("0"), scoreLikeImage(), false));
  const accepted = gate.handle(gateInput("a2", fingerprint("0"), scoreLikeImage(), false));
  assert.equal(accepted.exported, true);
  assert.equal(accepted.acceptedClusters.length, 1);

  const held = gate.handle(gateInput("b1", fingerprint("f"), scoreLikeImage(), true));
  assert.equal(held.endGate, "held");
  assert.equal(held.exported, false);
  assert.equal(held.acceptedClusters.length, 1);
  assert.equal(held.pendingEndCandidateCount, 1);
});

test("end candidate gate exports a near-end different score after consecutive confirmation", () => {
  const clusterer = new ScoreClusterer();
  const gate = new EndCandidateGate(clusterer);

  gate.handle(gateInput("a1", fingerprint("0"), scoreLikeImage(), false));
  gate.handle(gateInput("a2", fingerprint("0"), scoreLikeImage(), false));
  gate.handle(gateInput("b1", fingerprint("f"), scoreLikeImage(), true));
  const confirmed = gate.handle(gateInput("b2", fingerprint("f"), scoreLikeImage(), true));

  assert.equal(confirmed.endGate, "confirmed");
  assert.equal(confirmed.exported, true);
  assert.equal(confirmed.acceptedClusters.length, 2);
  assert.equal(confirmed.newClusterId, "score_cluster_2");
});

test("end candidate gate discards overlay-like near-end different samples", () => {
  const clusterer = new ScoreClusterer();
  const gate = new EndCandidateGate(clusterer);

  gate.handle(gateInput("a1", fingerprint("0"), scoreLikeImage(), false));
  gate.handle(gateInput("a2", fingerprint("0"), scoreLikeImage(), false));
  const discarded = gate.handle(gateInput("overlay1", fingerprint("f"), overlayImage(), true));

  assert.equal(discarded.endGate, "discarded_overlay");
  assert.equal(discarded.exported, false);
  assert.equal(discarded.acceptedClusters.length, 1);
});

test("end candidate gate discards unconfirmed candidate on capture stop", () => {
  const clusterer = new ScoreClusterer();
  const gate = new EndCandidateGate(clusterer);

  gate.handle(gateInput("a1", fingerprint("0"), scoreLikeImage(), false));
  gate.handle(gateInput("a2", fingerprint("0"), scoreLikeImage(), false));
  gate.handle(gateInput("b1", fingerprint("f"), scoreLikeImage(), true));
  const flushed = gate.flushUnconfirmed();

  assert.ok(flushed);
  assert.equal(flushed.endGate, "discarded_unconfirmed");
  assert.equal(flushed.exported, false);
  assert.equal(flushed.acceptedClusters.length, 1);
});

test("end candidate metrics identify score-like staff rows and dominant overlay blocks", () => {
  const scoreMetrics = measureEndCandidate(scoreLikeImage());
  const overlayMetrics = measureEndCandidate(overlayImage());

  assert.ok(scoreMetrics.staffRowRunCount >= 5);
  assert.ok(scoreMetrics.dominantRegionRatio < 0.35);
  assert.ok(overlayMetrics.dominantRegionRatio > 0.35);
});

function gateInput(id: string, fingerprintValue: ScoreFingerprint, normalized: NormalizedScoreImage, nearEnd: boolean): ClusterInput & {
  normalized: NormalizedScoreImage;
  nearEnd: boolean;
  videoEnded: boolean;
} {
  return {
    sample: sample(id),
    fingerprint: fingerprintValue,
    qualityScore: 0.8,
    imageBlobId: `roi-representative:${id}`,
    normalized,
    nearEnd,
    videoEnded: false
  };
}

function fingerprint(nibble: string): ScoreFingerprint {
  return {
    fullPHash: nibble.repeat(16),
    fullDHash: nibble.repeat(16),
    contentPHash: nibble.repeat(16),
    contentDHash: nibble.repeat(16),
    horizontalProjection: Array.from({ length: 8 }, () => (nibble === "0" ? 0.2 : 0.8)),
    verticalProjection: Array.from({ length: 8 }, () => (nibble === "0" ? 0.2 : 0.8)),
    aspectRatio: 2,
    inkDensity: nibble === "0" ? 0.08 : 0.12
  };
}

function sample(id: string): RoiSample {
  return {
    id,
    sessionId: "session_1",
    frameId: `frame_${id}`,
    timestampSec: Number.parseInt(id.replace(/\D/g, ""), 10) || 1,
    frameIndex: Number.parseInt(id.replace(/\D/g, ""), 10) || 1,
    roiRect: { x: 0, y: 0, width: 80, height: 40 },
    image: {
      width: 80,
      height: 40,
      bitmapRef: {} as HTMLCanvasElement
    }
  };
}

function scoreLikeImage(): NormalizedScoreImage {
  const image = blankImage(80, 40);
  for (const y of [12, 16, 20, 24, 28]) {
    for (let x = 6; x < 74; x += 1) {
      image.pixels[y * image.width + x] = 0;
    }
  }
  return image;
}

function overlayImage(): NormalizedScoreImage {
  const image = blankImage(80, 40);
  for (let y = 5; y < 35; y += 1) {
    for (let x = 20; x < 60; x += 1) {
      image.pixels[y * image.width + x] = 0;
    }
  }
  return image;
}

function blankImage(width: number, height: number): NormalizedScoreImage {
  return {
    width,
    height,
    pixels: new Uint8ClampedArray(width * height).fill(255)
  };
}
