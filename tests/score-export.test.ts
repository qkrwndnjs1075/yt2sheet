import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryCapturedScoreRepository } from "../src/offscreen/capture/captured-score-repository.js";
import type { ImageBlobMetadata, ImageBlobRepository } from "../src/offscreen/capture/image-blob-repository.js";
import { UniqueScoreCaptureService } from "../src/offscreen/capture/unique-score-capture-service.js";
import { ScorePageChunker } from "../src/offscreen/export/score-page-chunker.js";
import { ScoreExportService } from "../src/offscreen/export/score-export-service.js";
import { ScorePdfExporter } from "../src/offscreen/export/score-pdf-exporter.js";
import { ScorePngExporter } from "../src/offscreen/export/score-png-exporter.js";
import { ScoreIdentityDetector } from "../src/offscreen/identity/score-identity-detector.js";
import { ScoreClusterer } from "../src/offscreen/identity/score-clusterer.js";
import { chunkScorePages } from "../src/background/score-export-download.js";
import { FEATURE_FLAGS } from "../src/shared/feature-flags.js";
import { SCORE_IDENTITY_CONFIG } from "../src/shared/score-identity-config.js";
import type { CapturedScoreSystem, CaptureContext } from "../src/shared/capture-types.js";
import type { ScoreCluster } from "../src/shared/cluster-types.js";
import type { ScoreFingerprint } from "../src/shared/fingerprint-types.js";
import type { RoiSample } from "../src/shared/roi-types.js";

const ONE_BY_ONE_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x04, 0x00, 0x00, 0x00, 0xb5, 0x1c, 0x0c,
  0x02, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xfa, 0xcf, 0x00, 0x00,
  0x02, 0x07, 0x01, 0x02, 0x9a, 0x1c, 0x31, 0x71, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82
]);

test("score identity config and feature flags enforce ROI-only local identity", () => {
  assert.equal(SCORE_IDENTITY_CONFIG.sampling.sampleIntervalMs, 1000);
  assert.equal(FEATURE_FLAGS.useGeminiJudge, false);
  assert.equal(FEATURE_FLAGS.useAutoScoreRegionDetection, false);
  assert.equal(FEATURE_FLAGS.useManualRoiOnly, true);
});

test("clusterer stores the actual representative image blob id", () => {
  const clusterer = new ScoreClusterer();
  clusterer.handleFingerprint({ sample: sample(1), fingerprint: fingerprint("A"), qualityScore: 0.3, imageBlobId: "blob_low" });
  clusterer.handleFingerprint({ sample: sample(2), fingerprint: fingerprint("A"), qualityScore: 0.9, imageBlobId: "blob_high" });

  const [cluster] = clusterer.getAcceptedClusters();
  assert.equal(cluster.representativeSampleId, "sample_2");
  assert.equal(cluster.representativeImageBlobId, "blob_high");
});

test("unique capture service upserts accepted clusters by cluster id", async () => {
  const repository = new InMemoryCapturedScoreRepository();
  const images = new FakeImageRepository();
  const thumbnails = { generate: async (id: string) => `${id}:thumb` };
  const service = new UniqueScoreCaptureService(repository, images, thumbnails);
  const context = captureContext();
  const first = await service.upsertAcceptedCluster(cluster("A", "blob_a", 1, 0.3, 2), context);
  const updated = await service.upsertAcceptedCluster(cluster("A", "blob_b", 1, 0.9, 4), context);
  const stored = await repository.listBySession(context.sessionId);

  assert.equal(stored.length, 1);
  assert.equal(first.id, updated.id);
  assert.equal(stored[0]?.image.imageBlobId, "blob_b");
  assert.equal(stored[0]?.qualityScore, 0.9);
  assert.equal(stored[0]?.source.seenCount, 4);
});

test("unique capture service rejects accepted clusters without representative metadata", async () => {
  const repository = new InMemoryCapturedScoreRepository();
  const images = new FakeImageRepository();
  images.missingMetadataIds.add("missing_blob");
  const service = new UniqueScoreCaptureService(repository, images, { generate: async (id: string) => `${id}:thumb` });

  await assert.rejects(
    () => service.upsertAcceptedCluster(cluster("A", "missing_blob", 1, 0.8), captureContext()),
    /Representative image metadata not found/
  );
});

test("page chunker dedupes by cluster id and packs systems by page height", () => {
  // Given: duplicate captures for six systems whose width-fitted heights allow four per page.
  const chunker = new ScorePageChunker();
  const scores = ["A", "A", "B", "B", "C", "C", "D", "E", "E", "F"].map((id, index) =>
    captured(id, index + 1, index + 1)
  );
  // When: the offscreen export path creates pages.
  const pages = chunker.createPages("session_1", scores);

  // Then: duplicates are removed and overflow is based on printable height rather than a fixed count.
  assert.deepEqual(
    pages.map((page) => page.systems.map((system) => system.clusterId)),
    [["A", "B", "C", "D"], ["E", "F"]]
  );
  assert.equal(pages[0]?.width, SCORE_IDENTITY_CONFIG.page.pageWidth);
  assert.equal(pages[0]?.height, SCORE_IDENTITY_CONFIG.page.pageHeight);
});

test("page chunker creates the same occurrence sequence as active download chunking", () => {
  const chunker = new ScorePageChunker();
  const scores = [
    capturedOccurrence("A", "occ_A_1", 1),
    capturedOccurrence("A", "occ_A_1", 2),
    capturedOccurrence("A", "occ_A_1", 3),
    capturedOccurrence("B", "occ_B_1", 4),
    capturedOccurrence("A", "occ_A_2", 5),
    capturedOccurrence("A", "occ_A_2", 6),
    capturedOccurrence("C", "occ_C_1", 7)
  ];
  const activeSequence = chunkScorePages(scores).flat().map((system) => system.clusterId);
  const offscreenSequence = chunker.createPages("session_1", scores).flatMap((page) =>
    page.systems.map((system) => system.clusterId)
  );

  assert.deepEqual(offscreenSequence, activeSequence);
  assert.deepEqual(offscreenSequence, ["A", "B", "A", "C"]);
  assert.deepEqual(
    chunker.createPages("session_1", scores).flatMap((page) => page.systems.map((system) => system.occurrenceId)),
    ["occ_A_1", "occ_B_1", "occ_A_2", "occ_C_1"]
  );
});

test("PNG exporter returns rendered page blobs by page order", async () => {
  const images = new FakeImageRepository();
  const exporter = new ScorePngExporter(images);
  const blobs = await exporter.exportPages([
    { id: "page_1", sessionId: "session_1", pageIndex: 0, systems: [], imageBlobId: "blob_a", width: 1200, height: 1700 },
    { id: "page_2", sessionId: "session_1", pageIndex: 1, systems: [], imageBlobId: "blob_b", width: 1200, height: 1700 }
  ]);

  assert.deepEqual(await Promise.all(blobs.map((blob) => blob.text())), ["blob_a", "blob_b"]);
});

test("PDF exporter combines PNG page images into one PDF blob", async () => {
  const pdf = await new ScorePdfExporter().export([new Blob([ONE_BY_ONE_PNG], { type: "image/png" })]);
  const header = await pdf.slice(0, 5).text();

  assert.equal(pdf.type, "application/pdf");
  assert.equal(header, "%PDF-");
});

test("export service renders pages, stores page images, and exports PNG/PDF from captured systems", async () => {
  const images = new FakeImageRepository();
  const renderer = {
    render: async () => new Blob([ONE_BY_ONE_PNG], { type: "image/png" })
  };
  const service = new ScoreExportService(images, new ScorePageChunker(), renderer);
  const systems = ["A", "A", "B", "B", "C", "D"].map((id, index) => captured(id, index + 1, index + 1));
  const pages = await service.createRenderedPages("session_1", systems);
  const pngPages = await new ScorePngExporter(images).exportPages(pages);
  const pdf = await service.exportPdf("session_1", systems);

  assert.deepEqual(pages.map((page) => page.systems.map((system) => system.clusterId)), [["A", "B", "C", "D"]]);
  assert.equal(pages[0]?.imageBlobId, "score-page:session_1:1");
  assert.equal(pngPages.length, 1);
  assert.equal(pngPages[0]?.type, "image/png");
  assert.equal(await pdf.slice(0, 5).text(), "%PDF-");
});

test("score identity detector captures accepted unique clusters and deletes duplicate raw samples", async () => {
  const images = new FakeImageRepository();
  const captures = new Map<string, ScoreCluster>();
  const detector = new ScoreIdentityDetector(
    { generate: (input: RoiSample) => fingerprint(input.id === "sample_3" || input.id === "sample_4" ? "B" : "A") },
    { evaluate: () => ({ score: 0.5, blurScore: 0.5, contrastScore: 0.5, cursorPenalty: 0, marginPenalty: 0, resolutionScore: 1 }) },
    images,
    new ScoreClusterer(),
    { upsertAcceptedCluster: async (cluster: ScoreCluster) => captures.set(cluster.id, { ...cluster }) } as never,
    { log: () => undefined } as never,
    { normalize: () => ({ width: 512, height: 160, pixels: new Uint8ClampedArray(512 * 160).fill(255) }) }
  );
  const context = captureContext();

  await detector.handleSample(sample(1), context);
  await detector.handleSample(sample(2), context);
  await detector.handleSample(sample(3), context);
  await detector.handleSample(sample(4), context);

  assert.deepEqual([...captures.keys()], ["score_cluster_1", "score_cluster_2"]);
  assert.deepEqual(images.deleted, ["blob_sample_2", "blob_sample_4"]);
});

test("score identity detector deletes stale representative image and thumbnail when quality improves", async () => {
  const images = new FakeImageRepository();
  const captures = new Map<string, ScoreCluster>();
  const qualities = [0.1, 0.9];
  const detector = new ScoreIdentityDetector(
    { generate: () => fingerprint("A") },
    { evaluate: () => ({ score: qualities.shift() ?? 0.9, blurScore: 0.5, contrastScore: 0.5, cursorPenalty: 0, marginPenalty: 0, resolutionScore: 1 }) },
    images,
    new ScoreClusterer(),
    { upsertAcceptedCluster: async (cluster: ScoreCluster) => captures.set(cluster.id, { ...cluster }) } as never,
    { log: () => undefined } as never,
    { normalize: () => ({ width: 512, height: 160, pixels: new Uint8ClampedArray(512 * 160).fill(255) }) }
  );

  await detector.handleSample(sample(1), captureContext());
  await detector.handleSample(sample(2), captureContext());

  assert.equal(captures.get("score_cluster_1")?.representativeImageBlobId, "blob_sample_2");
  assert.deepEqual(images.deleted, ["blob_sample_1", "roi-thumbnail:blob_sample_1"]);
});

test("score identity detector deletes pending duplicate image when it resolves into an existing cluster", async () => {
  const images = new FakeImageRepository();
  const detector = new ScoreIdentityDetector(
    { generate: (input: RoiSample) => fingerprint(input.id === "sample_3" ? "A-maybe" : "A") },
    { evaluate: () => ({ score: 0.5, blurScore: 0.5, contrastScore: 0.5, cursorPenalty: 0, marginPenalty: 0, resolutionScore: 1 }) },
    images,
    new ScoreClusterer(),
    { upsertAcceptedCluster: async () => undefined } as never,
    { log: () => undefined } as never,
    { normalize: () => ({ width: 512, height: 160, pixels: new Uint8ClampedArray(512 * 160).fill(255) }) }
  );

  await detector.handleSample(sample(1), captureContext());
  await detector.handleSample(sample(2), captureContext());
  await detector.handleSample(sample(3), captureContext());
  await detector.handleSample(sample(4), captureContext());

  assert.deepEqual([...images.deleted].sort(), ["blob_sample_2", "blob_sample_3", "blob_sample_4"]);
});

class FakeImageRepository implements ImageBlobRepository {
  readonly deleted: string[] = [];
  readonly missingMetadataIds = new Set<string>();
  private readonly blobs = new Map<string, Blob>();

  constructor() {
    for (const id of ["blob_a", "blob_b"]) {
      this.blobs.set(id, new Blob([id], { type: "image/png" }));
    }
  }

  async saveSampleImage(input: RoiSample): Promise<string> {
    const id = `blob_${input.id}`;
    this.blobs.set(id, new Blob([id], { type: "image/png" }));
    return id;
  }

  async saveBlob(id: string, blob: Blob): Promise<string> {
    this.blobs.set(id, blob);
    return id;
  }

  async loadBlob(id: string): Promise<Blob> {
    return this.blobs.get(id) ?? new Blob([id], { type: "image/png" });
  }

  async loadImageBitmap(): Promise<ImageBitmap> {
    return { width: 1, height: 1 } as ImageBitmap;
  }

  async getMetadata(id: string): Promise<ImageBlobMetadata | null> {
    if (this.missingMetadataIds.has(id)) {
      return null;
    }
    return { id, width: 512, height: 160, type: "image/png" };
  }

  async delete(id: string): Promise<void> {
    this.deleted.push(id);
    this.blobs.delete(id);
  }
}

function captureContext(): CaptureContext {
  return {
    sessionId: "session_1",
    videoId: "video_1",
    url: "https://www.youtube.com/watch?v=video_1"
  };
}

function captured(clusterId: string, firstSeenSec: number, order: number): CapturedScoreSystem {
  return {
    id: `captured_${clusterId}_${order}`,
    sessionId: "session_1",
    clusterId,
    source: {
      videoId: "video_1",
      url: "https://www.youtube.com/watch?v=video_1",
      firstSeenSec,
      lastSeenSec: firstSeenSec
    },
    image: {
      imageBlobId: `blob_${clusterId}`,
      width: 512,
      height: 160,
      dataUrl: `data:image/png;base64,${Buffer.from(clusterId).toString("base64")}`
    },
    fingerprint: fingerprint(clusterId),
    qualityScore: 0.8,
    order
  };
}

function capturedOccurrence(clusterId: string, occurrenceId: string, occurrenceOrder: number): CapturedScoreSystem {
  const current = captured(clusterId, occurrenceOrder, occurrenceOrder);
  return {
    ...current,
    id: `captured_${occurrenceId}_${occurrenceOrder}`,
    occurrenceId,
    occurrenceOrder
  };
}

function cluster(id: string, imageBlobId: string, firstSeenSec: number, qualityScore: number, seenCount = 1): ScoreCluster {
  return {
    id,
    sessionId: "session_1",
    firstSeenSec,
    lastSeenSec: firstSeenSec,
    seenCount,
    representativeSampleId: `${id}_sample`,
    representativeImageBlobId: imageBlobId,
    fingerprint: fingerprint(id),
    bestQualityScore: qualityScore,
    status: "accepted"
  };
}

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

  return base;
}

function filled(length: number, value: number): number[] {
  return new Array<number>(length).fill(value);
}

function alternating(length: number): number[] {
  return Array.from({ length }, (_value, index) => (index % 2 === 0 ? 0.01 : 0.8));
}
