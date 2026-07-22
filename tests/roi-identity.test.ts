import assert from "node:assert/strict";
import { test } from "node:test";
import { UniqueScoreCandidateBuilder } from "../src/offscreen/capture/unique-score-candidate-builder.js";
import { FingerprintGenerator } from "../src/offscreen/identity/fingerprint-generator.js";
import { ScoreClusterer } from "../src/offscreen/identity/score-clusterer.js";
import { compareScoreFingerprints, decideSameScore } from "../src/offscreen/identity/score-similarity.js";
import { createNormalizedImage } from "../src/offscreen/identity/score-normalizer.js";
import { extractStaffContent, findStaffContentRect } from "../src/offscreen/identity/staff-content-extractor.js";
import { StaffLineSuppressor } from "../src/offscreen/identity/staff-line-suppressor.js";
import { frameRectToCaptureBitmapRect, videoContentRect, viewportRectToFrameRect } from "../src/shared/roi-geometry.js";
import { SCORE_IDENTITY_CONFIG } from "../src/shared/score-identity-config.js";
import { DEFAULT_SAMPLE_INTERVAL_MS } from "../src/shared/types.js";
import type { ScoreCluster } from "../src/shared/cluster-types.js";
import type { ScoreFingerprint } from "../src/shared/fingerprint-types.js";
import type { RoiSample } from "../src/shared/roi-types.js";

test("default sampling interval is one second", () => {
  assert.equal(DEFAULT_SAMPLE_INTERVAL_MS, 1000);
});

test("end gate config uses rule-first two-confirmation defaults", () => {
  assert.equal(SCORE_IDENTITY_CONFIG.cluster.minAcceptSeenCount, 2);
  assert.equal(SCORE_IDENTITY_CONFIG.endGate.nearEndWindowMs, 3000);
  assert.equal(SCORE_IDENTITY_CONFIG.endGate.endCandidateRequiredConfirmations, 2);
  assert.equal(SCORE_IDENTITY_CONFIG.endGate.maxEndCandidateCropAreaDiff, 0.4);
  assert.equal(SCORE_IDENTITY_CONFIG.endGate.maxEndCandidateInkDensityDiff, 0.18);
  assert.equal(SCORE_IDENTITY_CONFIG.endGate.maxOverlayDominantRegionRatio, 0.35);
});

test("viewport ROI converts to original frame coordinates", () => {
  assert.deepEqual(
    viewportRectToFrameRect({
      videoRect: { left: 100, top: 50, width: 800, height: 450 },
      selectionRect: { left: 300, top: 140, width: 400, height: 180 },
      frameSize: { width: 1920, height: 1080 }
    }),
    { x: 480, y: 216, width: 960, height: 432 }
  );
});

test("viewport ROI conversion ignores letterbox bars around the rendered video frame", () => {
  const videoRect = { left: 0, top: 0, width: 800, height: 600 };
  const frameSize = { width: 1920, height: 1080 };

  assert.deepEqual(videoContentRect(videoRect, frameSize), { left: 0, top: 75, width: 800, height: 450 });
  assert.deepEqual(
    viewportRectToFrameRect({
      videoRect,
      selectionRect: { left: 0, top: 75, width: 800, height: 450 },
      frameSize
    }),
    { x: 0, y: 0, width: 1920, height: 1080 }
  );
});

test("frame ROI maps back into tab capture bitmap coordinates for normal YouTube layout", () => {
  const frameRect = viewportRectToFrameRect({
    videoRect: { left: 100, top: 50, width: 800, height: 450 },
    selectionRect: { left: 300, top: 140, width: 400, height: 180 },
    frameSize: { width: 1920, height: 1080 }
  });

  assert.deepEqual(
    frameRectToCaptureBitmapRect({
      frameRect,
      videoRect: { left: 100, top: 50, width: 800, height: 450 },
      frameSize: { width: 1920, height: 1080 },
      viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
      bitmapSize: { width: 1280, height: 720 }
    }),
    { x: 300, y: 140, width: 400, height: 180 }
  );
});

test("frame ROI does not extend into the YouTube title below a letterboxed video capture", () => {
  assert.deepEqual(
    frameRectToCaptureBitmapRect({
      frameRect: { x: 0, y: 0, width: 1920, height: 720 },
      videoRect: { left: 0, top: 0, width: 1600, height: 600 },
      frameSize: { width: 1920, height: 720 },
      viewport: { width: 1600, height: 900, devicePixelRatio: 1 },
      bitmapSize: { width: 1280, height: 1024 }
    }),
    { x: 0, y: 152, width: 1280, height: 480 }
  );
});

test("same score decision uses content hashes and projections", () => {
  assert.equal(decideSameScore(fingerprint("A"), fingerprint("A")), "same");
  assert.equal(decideSameScore(fingerprint("A-maybe"), fingerprint("A")), "maybe_same");
  assert.equal(decideSameScore(fingerprint("B"), fingerprint("A")), "different");
});

test("changed notation distribution is not merged as the same score", () => {
  assert.notEqual(decideSameScore(fingerprint("A-shifted-notes"), fingerprint("A")), "same");

  const clusterer = new ScoreClusterer();
  clusterer.addSample(sample(1), fingerprint("A"), 0.5);
  clusterer.addSample(sample(2), fingerprint("A"), 0.5);
  const pending = clusterer.addSample(sample(3), fingerprint("A-shifted-notes"), 0.9);
  const update = clusterer.addSample(sample(4), fingerprint("A-shifted-notes"), 0.9);

  assert.equal(pending.exported, false);
  assert.equal(update.decision, "different");
  assert.equal(clusterer.getAcceptedClusters().length, 2);
});

test("fingerprint comparison ignores side imagery that is outside the staff-line content", () => {
  const generator = new FingerprintGenerator();
  const first = generator.generate(scoreImageWithSideImage("blocks"), 3.2);
  const second = generator.generate(scoreImageWithSideImage("stripes"), 3.2);

  assert.equal(compareScoreFingerprints(first, second).decision, "same");
});

test("staff content extraction crops side imagery outside the score staff lines", () => {
  const image = scoreImageWithSideImage("blocks");
  const rect = findStaffContentRect(image.width, image.height, (x, y) => image.pixels[y * image.width + x] ?? 255);
  const extracted = extractStaffContent(image);

  assert.ok(rect.width < image.width * 0.82);
  assert.ok(extracted.width < image.width);
  assert.ok(extracted.height <= image.height);
});

test("fingerprint generator creates full and content hashes after staff suppression", () => {
  const image = scoreImageWithStaffAndNote();
  const suppressed = new StaffLineSuppressor().suppress(image);
  const fingerprint = new FingerprintGenerator().generate(image, 3.2);

  assert.equal(fingerprint.fullPHash.length, 16);
  assert.equal(fingerprint.fullDHash.length, 16);
  assert.equal(fingerprint.contentPHash.length, 16);
  assert.equal(fingerprint.contentDHash.length, 16);
  assert.equal(fingerprint.horizontalProjection.length, 32);
  assert.equal(fingerprint.verticalProjection.length, 64);
  assert.ok(fingerprint.inkDensity > 0);
  assert.ok(countDarkPixels(suppressed.pixels) < countDarkPixels(image.pixels));
});

test("A,A,A,B,B,C,C samples produce stable A,B,C clusters", () => {
  const clusterer = new ScoreClusterer();
  const sequence = ["A", "A", "A", "B", "B", "C", "C"];

  sequence.forEach((kind, index) => {
    clusterer.addSample(sample(index + 1), fingerprint(kind), 0.5);
  });

  assert.deepEqual(clusterer.getAcceptedClusters().map((cluster) => cluster.seenCount), [3, 2, 2]);
  assert.equal(clusterer.getAcceptedClusters().length, 3);
});

test("sequential score changes preserve one-sample intermediate scores after initial lock", () => {
  // Given: score 1 is locked, scores 2-4 each span one sampling interval, and score 5 remains visible.
  const clusterer = new ScoreClusterer();
  const sequence = ["A", "A", "B", "C", "D", "E", "E"];

  // When: samples arrive in playback order.
  sequence.forEach((kind, index) => {
    clusterer.addSample(sample(index + 1), fingerprint(kind), 0.5);
  });

  // Then: no intermediate score is replaced by the next pending transition.
  assert.deepEqual(
    clusterer.getAcceptedClusters().map((cluster) => cluster.fingerprint.contentPHash),
    ["0", "f", "a", "5", "3"].map((value) => value.repeat(16))
  );
});

test("a new score stays pending until a matching second observation confirms it", () => {
  const clusterer = new ScoreClusterer();

  const pending = clusterer.addSample(sample(1), fingerprint("A"), 0.5);
  assert.equal(pending.exported, false);
  assert.equal(clusterer.getAcceptedClusters().length, 0);
  assert.equal(clusterer.getPendingCount(), 1);

  const confirmed = clusterer.addSample(sample(2), fingerprint("A"), 0.8);
  assert.equal(confirmed.exported, true);
  assert.equal(clusterer.getAcceptedClusters().length, 1);
  assert.equal(clusterer.getAcceptedClusters()[0]?.seenCount, 2);
});

test("an unconfirmed transition frame is discarded when a different score follows", () => {
  const clusterer = new ScoreClusterer();

  clusterer.addSample(sample(1), fingerprint("A"), 0.5);
  const replaced = clusterer.addSample(sample(2), fingerprint("B"), 0.5);

  assert.equal(replaced.exported, false);
  assert.equal(clusterer.getAcceptedClusters().length, 0);
  assert.equal(clusterer.getPendingCount(), 1);

  clusterer.addSample(sample(3), fingerprint("B"), 0.5);
  assert.deepEqual(clusterer.getAcceptedClusters().map((cluster) => cluster.seenCount), [2]);
});

test("maybe_same sample waits pending and merges when the following sample matches the target cluster", () => {
  const clusterer = new ScoreClusterer();
  clusterer.addSample(sample(1), fingerprint("A"), 0.5);
  clusterer.addSample(sample(2), fingerprint("A"), 0.5);

  const pending = clusterer.addSample(sample(3), fingerprint("A-maybe"), 0.5);
  assert.equal(pending.decision, "maybe_same");
  assert.equal(clusterer.getAcceptedClusters().length, 1);
  assert.equal(clusterer.getPendingCount(), 1);

  const resolved = clusterer.addSample(sample(4), fingerprint("A"), 0.5);
  assert.equal(resolved.decision, "same");
  assert.equal(clusterer.getPendingCount(), 0);
  assert.equal(clusterer.getAcceptedClusters().length, 1);
  assert.deepEqual(clusterer.getAcceptedClusters().map((cluster) => cluster.seenCount), [4]);
});

test("maybe_same sample becomes a new accepted cluster when the following sample confirms it", () => {
  const clusterer = new ScoreClusterer();
  clusterer.addSample(sample(1), fingerprint("A"), 0.5);
  clusterer.addSample(sample(2), fingerprint("A"), 0.5);
  clusterer.addSample(sample(3), fingerprint("A-maybe"), 0.5);

  const resolved = clusterer.addSample(sample(4), fingerprint("A-maybe"), 0.5);

  assert.equal(resolved.decision, "different");
  assert.equal(resolved.newClusterId, "score_cluster_2");
  assert.equal(clusterer.getPendingCount(), 0);
  assert.equal(clusterer.getAcceptedClusters().length, 2);
  assert.deepEqual(clusterer.getAcceptedClusters().map((cluster) => cluster.seenCount), [2, 2]);
});

test("unconfirmed maybe-same sample is discarded when current sample matches another cluster", () => {
  const clusterer = new ScoreClusterer();
  clusterer.addSample(sample(1), fingerprint("A"), 0.5);
  clusterer.addSample(sample(2), fingerprint("A"), 0.5);
  clusterer.addSample(sample(3), fingerprint("B"), 0.5);
  clusterer.addSample(sample(4), fingerprint("B"), 0.5);
  clusterer.addSample(sample(5), fingerprint("A-maybe"), 0.5);

  const resolved = clusterer.addSample(sample(6), fingerprint("B"), 0.5);

  assert.equal(resolved.decision, "same");
  assert.equal(resolved.cluster?.id, "score_cluster_2");
  assert.equal(resolved.resolvedPendingCluster, undefined);
  assert.equal(resolved.newClusterId, undefined);
  assert.deepEqual(clusterer.getAcceptedClusters().map((cluster) => cluster.id), ["score_cluster_1", "score_cluster_2"]);
});

test("cluster representative updates to the best quality sample", () => {
  const clusterer = new ScoreClusterer();
  clusterer.addSample(sample(1), fingerprint("A"), 0.1);
  clusterer.addSample(sample(2), fingerprint("A"), 0.9);

  const [cluster] = clusterer.getAcceptedClusters();
  assert.equal(cluster.representativeSampleId, "sample_2");
  assert.equal(cluster.bestQualityScore, 0.9);
});

test("unique score builder packs width-fitted systems by page height", () => {
  // Given: six accepted systems whose fitted heights allow four systems per page.
  const builder = new UniqueScoreCandidateBuilder();
  const representativeImages = new Map([
    ["A_blob", image("A_blob")],
    ["B_blob", image("B_blob")],
    ["C_blob", image("C_blob")],
    ["D_blob", image("D_blob")],
    ["E_blob", image("E_blob")],
    ["F_blob", image("F_blob")]
  ]);
  const systems = builder.build(
    [cluster("A", 1, 3), cluster("B", 2), cluster("C", 3), cluster("D", 4), cluster("E", 5), cluster("F", 6)],
    { videoId: "video_1", url: "https://www.youtube.com/watch?v=video_1" },
    representativeImages
  );
  // When: the accepted systems are divided into export pages.
  const pages = builder.chunkPages(systems);

  // Then: the next system starts a page only when the remaining height is insufficient.
  assert.deepEqual(systems.map((system) => system.clusterId), ["A", "B", "C", "D", "E", "F"]);
  assert.equal(systems[0]?.image.dataUrl, "data:image/jpeg;base64,A_blob");
  assert.equal(systems[0]?.source.seenCount, 3);
  assert.equal(pages.length, 2);
  assert.deepEqual(pages.map((page) => page.map((system) => system.clusterId)), [["A", "B", "C", "D"], ["E", "F"]]);
});

test("unique score builder skips clusters without stored representative image", () => {
  const builder = new UniqueScoreCandidateBuilder();
  const systems = builder.build(
    [cluster("A", 1), cluster("B", 2)],
    { videoId: "video_1", url: "https://www.youtube.com/watch?v=video_1" },
    new Map([["A_blob", image("A_blob")]])
  );

  assert.deepEqual(systems.map((system) => system.clusterId), ["A"]);
});

test("similarity debug includes distances used by ROI identity logs", () => {
  const debug = compareScoreFingerprints(fingerprint("A-maybe"), fingerprint("A"));

  assert.equal(debug.contentPHashDistance, 12);
  assert.equal(debug.contentDHashDistance, 8);
  assert.ok(debug.verticalProjectionSimilarity >= 0.9);
  assert.equal(debug.decision, "maybe_same");
});

function sample(index: number): RoiSample {
  return {
    id: `sample_${index}`,
    sessionId: "session_1",
    frameId: `frame_${index}`,
    timestampSec: index,
    frameIndex: index,
    roiRect: { x: 0, y: 0, width: 512, height: 160 },
    image: {
      width: 512,
      height: 160,
      bitmapRef: {} as HTMLCanvasElement
    }
  };
}

function cluster(id: string, firstSeenSec: number, seenCount = firstSeenSec): ScoreCluster {
  return {
    id,
    sessionId: "session_1",
    firstSeenSec,
    lastSeenSec: firstSeenSec,
    seenCount,
    representativeSampleId: `${id}_sample`,
    representativeImageBlobId: `${id}_blob`,
    fingerprint: fingerprint(id),
    bestQualityScore: 0.8,
    status: "accepted"
  };
}

function image(imageBlobId: string) {
  return {
    imageBlobId,
    thumbnailBlobId: `${imageBlobId}_thumb`,
    dataUrl: `data:image/jpeg;base64,${imageBlobId}`,
    width: 512,
    height: 160
  };
}

function fingerprint(kind: string): ScoreFingerprint {
  const base: ScoreFingerprint = {
    fullPHash: "0000000000000000",
    fullDHash: "0000000000000000",
    contentPHash: "0000000000000000",
    contentDHash: "0000000000000000",
    horizontalProjection: filled(32, 0.2),
    verticalProjection: filled(64, 0.2),
    aspectRatio: 3.2,
    inkDensity: 0.18
  };

  if (kind === "A" || kind === "F") {
    return base;
  }

  if (kind === "D" || kind === "E") {
    const value = kind === "D" ? "5" : "3";
    return {
      ...base,
      fullPHash: value.repeat(16),
      fullDHash: value.repeat(16),
      contentPHash: value.repeat(16),
      contentDHash: value.repeat(16)
    };
  }

  if (kind === "A-maybe") {
    return {
      ...base,
      contentPHash: "0000000000000fff",
      contentDHash: "00000000000000ff",
      verticalProjection: filled(64, 0.19),
      horizontalProjection: filled(32, 0.2),
      inkDensity: 0.2
    };
  }

  if (kind === "A-shifted-notes") {
    return {
      ...base,
      horizontalProjection: alternating(32),
      inkDensity: 0.19
    };
  }

  if (kind === "B") {
    return {
      ...base,
      fullPHash: "ffffffffffffffff",
      fullDHash: "ffffffffffffffff",
      contentPHash: "ffffffffffffffff",
      contentDHash: "ffffffffffffffff",
      verticalProjection: alternating(64),
      horizontalProjection: alternating(32),
      inkDensity: 0.42
    };
  }

  return {
    ...base,
    fullPHash: "aaaaaaaaaaaaaaaa",
    fullDHash: "aaaaaaaaaaaaaaaa",
    contentPHash: "aaaaaaaaaaaaaaaa",
    contentDHash: "aaaaaaaaaaaaaaaa",
    verticalProjection: alternating(64).reverse(),
    horizontalProjection: alternating(32).reverse(),
    inkDensity: 0.04
  };
}

function filled(length: number, value: number): number[] {
  return new Array<number>(length).fill(value);
}

function alternating(length: number): number[] {
  return Array.from({ length }, (_value, index) => (index % 2 === 0 ? 0.01 : 0.8));
}

function scoreImageWithStaffAndNote() {
  const width = 64;
  const height = 32;
  const pixels = new Array<number>(width * height).fill(255);

  for (const y of [8, 10, 12, 14, 16]) {
    for (let x = 4; x < width - 4; x += 1) {
      pixels[y * width + x] = 0;
    }
  }

  for (let y = 9; y < 16; y += 1) {
    for (let x = 28; x < 34; x += 1) {
      pixels[y * width + x] = 0;
    }
  }

  return createNormalizedImage(width, height, pixels);
}

function scoreImageWithSideImage(kind: "blocks" | "stripes") {
  const width = 200;
  const height = 80;
  const pixels = new Array<number>(width * height).fill(255);

  for (const y of [24, 28, 32, 36, 40]) {
    for (let x = 8; x < 140; x += 1) {
      pixels[y * width + x] = 0;
    }
  }

  for (let y = 27; y < 39; y += 1) {
    for (let x = 68; x < 80; x += 1) {
      pixels[y * width + x] = 0;
    }
  }

  for (let y = 8; y < 72; y += 1) {
    for (let x = 154; x < 196; x += 1) {
      const dark = kind === "blocks" ? (x + y) % 11 < 5 : x % 7 < 3;
      pixels[y * width + x] = dark ? 20 : 230;
    }
  }

  return createNormalizedImage(width, height, pixels);
}

function countDarkPixels(pixels: Uint8ClampedArray): number {
  return [...pixels].filter((pixel) => pixel < 150).length;
}
