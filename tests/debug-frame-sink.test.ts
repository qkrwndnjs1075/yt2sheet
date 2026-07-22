import assert from "node:assert/strict";
import { test } from "node:test";
import { buildExportOccurrencesForDebug, createRoiExportImage, DebugFrameSink } from "../src/offscreen/debug-frame-sink.js";
import { RoiSampler } from "../src/offscreen/roi/roi-sampler.js";
import type { OffscreenInputFrame } from "../src/offscreen/frame-sink.js";
import type { RoiSample, ScoreRoiConfig } from "../src/shared/roi-types.js";

test("debug frame sink default path does not call the legacy layout or AI detector", async () => {
  const sentMessages: unknown[] = [];
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      sendMessage: async (message: unknown) => {
        sentMessages.push(message);
        return { ok: true };
      }
    }
  };
  const sink = new DebugFrameSink();

  assert.equal("layoutDetector" in (sink as unknown as Record<string, unknown>), false);
  await sink.onFrame({
    id: "frame_1",
    sessionId: "session_1",
    source: {
      platform: "youtube",
      videoId: "video_1",
      url: "https://www.youtube.com/watch?v=video_1",
      title: "Synthetic"
    },
    timing: {
      timestampSec: 1,
      sampledAt: new Date(0).toISOString(),
      frameIndex: 1,
      playbackRate: 1
    },
    image: {
      width: 1,
      height: 1,
      bitmapRef: {} as HTMLCanvasElement
    },
    meta: {
      sampleIntervalMs: 1000,
      tabId: 1
    }
  });

  assert.equal(sentMessages.length, 1);
  assert.deepEqual(sentMessages[0], {
    type: "FRAME_SAMPLED",
    sessionId: "session_1",
    frameIndex: 1,
    timestampSec: 1,
    width: 1,
    height: 1,
    sampledAt: new Date(0).toISOString(),
    identity: {
      clusterCount: 0,
      acceptedClusterCount: 0,
      pendingCount: 0,
      skippedReason: "ROI_NOT_CONFIGURED"
    }
  });
});

test("ROI sampler maps video-frame ROI into the tab capture bitmap before cropping", () => {
  const previousDocument = globalThis.document;
  (globalThis as { document?: Document }).document = {
    createElement: () => new FakeCanvas()
  } as unknown as Document;

  try {
    const bitmap = blankBitmap(1280, 720);
    for (let y = 140; y < 320; y += 1) {
      for (let x = 300; x < 700; x += 1) {
        setBitmapPixel(bitmap, x, y, 0);
      }
    }

    const roiConfig: ScoreRoiConfig = {
      id: "roi_1",
      videoId: "video_1",
      url: "https://www.youtube.com/watch?v=video_1",
      roiRect: { x: 480, y: 216, width: 960, height: 432 },
      frameSize: { width: 1920, height: 1080 },
      coordinateSpace: "frame",
      createdAt: new Date(0).toISOString(),
      sampleIntervalMs: 1000
    };

    const sample = new RoiSampler().sample({
      id: "frame_1",
      sessionId: "session_1",
      source: {
        platform: "youtube",
        videoId: "video_1",
        url: "https://www.youtube.com/watch?v=video_1",
        title: "Synthetic"
      },
      timing: {
        timestampSec: 1,
        sampledAt: new Date(0).toISOString(),
        frameIndex: 1,
        playbackRate: 1
      },
      image: {
        width: bitmap.width,
        height: bitmap.height,
        bitmapRef: bitmap as unknown as HTMLCanvasElement
      },
      meta: {
        sampleIntervalMs: 1000,
        tabId: 1,
        videoRect: { left: 100, top: 50, width: 800, height: 450 },
        viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
        roiConfig
      }
    }, roiConfig);

    assert.equal(sample.image.width, 400);
    assert.equal(sample.image.height, 180);
    assert.ok(countDarkRgbaPixels((sample.image.bitmapRef as unknown as FakeCanvas).pixels) > 400 * 180 * 0.95);
  } finally {
    (globalThis as { document?: Document }).document = previousDocument;
  }
});

test("ROI export image preserves the complete selected area before PDF export", () => {
  const previousDocument = globalThis.document;
  (globalThis as { document?: Document }).document = {
    createElement: () => new FakeCanvas()
  } as unknown as Document;

  try {
    const sample = roiSampleWithSideImage();
    const image = createRoiExportImage(sample);

    assert.equal(image.width, sample.image.width);
    assert.equal(image.height, sample.image.height);
    assert.match(image.dataUrl, /^data:image\/png;mock,/);
  } finally {
    (globalThis as { document?: Document }).document = previousDocument;
  }
});

test("debug frame sink emits complete ROI images for export after stability confirmation", async () => {
  const sentMessages: unknown[] = [];
  const previousDocument = globalThis.document;
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      sendMessage: async (message: unknown) => {
        sentMessages.push(message);
        return { ok: true };
      }
    }
  };
  (globalThis as { document?: Document }).document = {
    createElement: () => new FakeCanvas()
  } as unknown as Document;

  try {
    const bitmap = roiBitmapWithSideImage();
    const sink = new DebugFrameSink();
    const frame: OffscreenInputFrame = {
      id: "frame_1",
      sessionId: "session_1",
      source: {
        platform: "youtube",
        videoId: "video_1",
        url: "https://www.youtube.com/watch?v=video_1",
        title: "Synthetic"
      },
      timing: {
        timestampSec: 1,
        sampledAt: new Date(0).toISOString(),
        frameIndex: 1,
        playbackRate: 1
      },
      image: {
        width: bitmap.width,
        height: bitmap.height,
        bitmapRef: bitmap as unknown as HTMLCanvasElement
      },
      meta: {
        sampleIntervalMs: 1000,
        tabId: 1,
        roiConfig: {
          id: "roi_1",
          videoId: "video_1",
          url: "https://www.youtube.com/watch?v=video_1",
          roiRect: { x: 0, y: 0, width: bitmap.width, height: bitmap.height },
          coordinateSpace: "frame",
          createdAt: new Date(0).toISOString(),
          sampleIntervalMs: 1000
        }
      }
    };
    await sink.onFrame(frame);
    await sink.onFrame({
      ...frame,
      id: "frame_2",
      timing: { ...frame.timing, timestampSec: 2, frameIndex: 2 }
    });

    const frameMessage = sentMessages.filter((message) => isFrameMessage(message)).at(-1);
    assert.ok(frameMessage);
    const score = frameMessage.uniqueScores?.[0];
    assert.ok(score);
    assert.equal(score.image.width, bitmap.width);
    assert.equal(score.image.height, bitmap.height);
    assert.match(score.image.dataUrl ?? "", /^data:image\/png;mock,/);
    assert.deepEqual(frameMessage.exportOccurrences?.map((occurrence) => occurrence.clusterId), ["score_cluster_1"]);
  } finally {
    (globalThis as { document?: Document }).document = previousDocument;
  }
});

test("debug frame sink sends each full export image only once", async () => {
  const sentMessages: unknown[] = [];
  const previousDocument = globalThis.document;
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      sendMessage: async (message: unknown) => {
        sentMessages.push(message);
        return { ok: true };
      }
    }
  };
  (globalThis as { document?: Document }).document = {
    createElement: () => new FakeCanvas()
  } as unknown as Document;

  try {
    const bitmap = roiBitmapWithSideImage();
    const roiConfig: ScoreRoiConfig = {
      id: "roi_1",
      videoId: "video_1",
      url: "https://www.youtube.com/watch?v=video_1",
      roiRect: { x: 0, y: 0, width: bitmap.width, height: bitmap.height },
      coordinateSpace: "frame",
      createdAt: new Date(0).toISOString(),
      sampleIntervalMs: 1000
    };
    const sink = new DebugFrameSink();

    await sink.onFrame(frameWithBitmap("frame_1", bitmap, roiConfig, false));
    await sink.onFrame(frameWithBitmap("frame_2", bitmap, roiConfig, false));
    await sink.onFrame(frameWithBitmap("frame_3", bitmap, roiConfig, false));

    const messages = sentMessages.filter(isFrameMessage);
    const accepted = messages.at(-2);
    const repeated = messages.at(-1);
    assert.ok(accepted);
    assert.ok(repeated);
    assert.equal(countScoreDataUrls(accepted), 1);
    assert.equal(repeated.uniqueScores?.[0]?.image.dataUrl, undefined);
    assert.ok(countScoreDataUrls(repeated) <= 1, "a later frame may carry only its newly retained candidate image");
    assert.ok(
      repeated.exportCandidates?.every((candidate) => candidate.qualityScore > 0),
      "every retained temporal candidate must keep its measured quality"
    );
  } finally {
    (globalThis as { document?: Document }).document = previousDocument;
  }
});

test("debug frame sink excludes near-end overlay candidates from unique export", async () => {
  const sentMessages: unknown[] = [];
  const previousDocument = globalThis.document;
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      sendMessage: async (message: unknown) => {
        sentMessages.push(message);
        return { ok: true };
      }
    }
  };
  (globalThis as { document?: Document }).document = {
    createElement: () => new FakeCanvas()
  } as unknown as Document;

  try {
    const sink = new DebugFrameSink();
    const roiConfig: ScoreRoiConfig = {
      id: "roi_1",
      videoId: "video_1",
      url: "https://www.youtube.com/watch?v=video_1",
      roiRect: { x: 0, y: 0, width: 200, height: 80 },
      coordinateSpace: "frame",
      createdAt: new Date(0).toISOString(),
      sampleIntervalMs: 1000
    };

    await sink.onFrame(frameWithBitmap("frame_1", roiBitmapWithSideImage(), roiConfig, false));
    await sink.onFrame(frameWithBitmap("frame_2", roiBitmapWithSideImage(), roiConfig, false));
    await sink.onFrame(frameWithBitmap("frame_3", roiBitmapWithEndOverlay(), roiConfig, true));

    const frameMessages = sentMessages.filter((message) => isFrameMessage(message));
    const finalMessage = frameMessages.at(-1);
    assert.ok(finalMessage);
    assert.equal(finalMessage.identity?.endGate, "discarded_overlay");
    assert.equal(finalMessage.identity?.exported, false);
    assert.equal(finalMessage.uniqueScores?.length, 1);
  } finally {
    (globalThis as { document?: Document }).document = previousDocument;
  }
});

test("debug frame sink emits repeated non-consecutive cluster occurrences for export state", async () => {
  const sentMessages: unknown[] = [];
  const previousDocument = globalThis.document;
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      sendMessage: async (message: unknown) => {
        sentMessages.push(message);
        return { ok: true };
      }
    }
  };
  (globalThis as { document?: Document }).document = {
    createElement: () => new FakeCanvas()
  } as unknown as Document;

  try {
    const sink = new DebugFrameSink();
    const roiConfig: ScoreRoiConfig = {
      id: "roi_1",
      videoId: "video_1",
      url: "https://www.youtube.com/watch?v=video_1",
      roiRect: { x: 0, y: 0, width: 200, height: 80 },
      coordinateSpace: "frame",
      createdAt: new Date(0).toISOString(),
      sampleIntervalMs: 1000
    };
    const sequence = ["A", "A", "A", "B", "B", "A", "A", "C", "C"] as const;

    for (const [index, kind] of sequence.entries()) {
      await sink.onFrame(frameWithBitmap(`frame_${index + 1}`, roiBitmapForOccurrenceKind(kind), roiConfig, false));
    }

    const frameMessages = sentMessages.filter((message) => isFrameMessage(message));
    const finalMessage = frameMessages.at(-1);

    assert.ok(finalMessage);
    assert.deepEqual(finalMessage.uniqueScores?.map((score) => score.clusterId), ["score_cluster_1", "score_cluster_2", "score_cluster_3"]);
    assert.deepEqual(finalMessage.exportOccurrences?.map((score) => score.clusterId), [
      "score_cluster_1",
      "score_cluster_2",
      "score_cluster_1",
      "score_cluster_3"
    ]);
    assert.deepEqual(finalMessage.exportOccurrences?.map((score) => score.occurrenceOrder), [1, 2, 3, 4]);
    assert.notEqual(finalMessage.exportOccurrences?.[0]?.occurrenceId, finalMessage.exportOccurrences?.[2]?.occurrenceId);
  } finally {
    (globalThis as { document?: Document }).document = previousDocument;
  }
});

test("buildExportOccurrencesForDebug collapses only consecutive same-cluster scores", () => {
  const scores = ["A", "A", "A", "B", "A", "A", "C"].map((clusterId, index) =>
    scoreLike({
      id: `score_${index + 1}`,
      clusterId,
      firstSeenSec: index,
      lastSeenSec: index,
      order: index + 1,
      seenCount: 1
    })
  );

  const occurrences = buildExportOccurrencesForDebug(scores);

  assert.deepEqual(occurrences.map((occurrence) => occurrence.clusterId), ["A", "B", "A", "C"]);
  assert.deepEqual(occurrences.map((occurrence) => occurrence.order), [1, 2, 3, 4]);
  assert.deepEqual(occurrences.map((occurrence) => occurrence.occurrenceOrder), [1, 2, 3, 4]);
  assert.notEqual(occurrences[0]?.id, occurrences[2]?.id);
  assert.notEqual(occurrences[0]?.occurrenceId, occurrences[2]?.occurrenceId);
  assert.equal(occurrences[0]?.source.firstSeenSec, 0);
  assert.equal(occurrences[0]?.source.lastSeenSec, 2);
  assert.equal(occurrences[0]?.source.seenCount, 3);
  assert.equal(occurrences[2]?.source.firstSeenSec, 4);
  assert.equal(occurrences[2]?.source.lastSeenSec, 5);
  assert.equal(occurrences[2]?.source.seenCount, 2);
});

test("buildExportOccurrencesForDebug handles empty and single-cluster score sequences", () => {
  const singleClusterScores = ["A", "A", "A"].map((clusterId, index) =>
    scoreLike({
      id: `score_${index + 1}`,
      clusterId,
      firstSeenSec: index + 10,
      lastSeenSec: index + 10,
      order: index + 1,
      seenCount: 1
    })
  );

  assert.deepEqual(buildExportOccurrencesForDebug([]), []);

  const occurrences = buildExportOccurrencesForDebug(singleClusterScores);

  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0]?.clusterId, "A");
  assert.equal(occurrences[0]?.order, 1);
  assert.equal(occurrences[0]?.source.firstSeenSec, 10);
  assert.equal(occurrences[0]?.source.lastSeenSec, 12);
  assert.equal(occurrences[0]?.source.seenCount, 3);
});

type FakeBitmap = {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
};

class FakeCanvas {
  private canvasWidth = 0;
  private canvasHeight = 0;
  pixels = new Uint8ClampedArray();

  get width(): number {
    return this.canvasWidth;
  }

  set width(value: number) {
    this.canvasWidth = value;
    this.resize();
  }

  get height(): number {
    return this.canvasHeight;
  }

  set height(value: number) {
    this.canvasHeight = value;
    this.resize();
  }

  getContext(): FakeCanvasContext {
    return new FakeCanvasContext(this);
  }

  toDataURL(): string {
    return `data:image/png;mock,width=${this.width};height=${this.height}`;
  }

  private resize(): void {
    this.pixels = new Uint8ClampedArray(Math.max(0, this.width * this.height * 4));
    for (let index = 0; index < this.pixels.length; index += 4) {
      this.pixels[index] = 255;
      this.pixels[index + 1] = 255;
      this.pixels[index + 2] = 255;
      this.pixels[index + 3] = 255;
    }
  }
}

class FakeCanvasContext {
  fillStyle = "#fff";

  constructor(private readonly canvas: FakeCanvas) {}

  fillRect(x: number, y: number, width: number, height: number): void {
    for (let yy = y; yy < y + height; yy += 1) {
      for (let xx = x; xx < x + width; xx += 1) {
        this.setPixel(xx, yy, 255, 255, 255, 255);
      }
    }
  }

  drawImage(source: FakeCanvas | FakeBitmap, ...args: number[]): void {
    const sourcePixels = source instanceof FakeCanvas ? source.pixels : source.pixels;
    const sourceWidth = source.width;
    const sourceHeight = source.height;
    const [sx, sy, sw, sh, dx, dy] = args.length >= 8 ? args : [0, 0, sourceWidth, sourceHeight, args[0] ?? 0, args[1] ?? 0];

    for (let y = 0; y < sh; y += 1) {
      for (let x = 0; x < sw; x += 1) {
        const sourceX = sx + x;
        const sourceY = sy + y;
        const targetX = dx + x;
        const targetY = dy + y;
        const sourceOffset = (sourceY * sourceWidth + sourceX) * 4;
        this.setPixel(
          targetX,
          targetY,
          sourcePixels[sourceOffset] ?? 255,
          sourcePixels[sourceOffset + 1] ?? 255,
          sourcePixels[sourceOffset + 2] ?? 255,
          sourcePixels[sourceOffset + 3] ?? 255
        );
      }
    }
  }

  getImageData(_x: number, _y: number, width: number, height: number): ImageData {
    return {
      width,
      height,
      data: this.canvas.pixels
    } as ImageData;
  }

  private setPixel(x: number, y: number, r: number, g: number, b: number, a: number): void {
    if (x < 0 || y < 0 || x >= this.canvas.width || y >= this.canvas.height) {
      return;
    }

    const offset = (y * this.canvas.width + x) * 4;
    this.canvas.pixels[offset] = r;
    this.canvas.pixels[offset + 1] = g;
    this.canvas.pixels[offset + 2] = b;
    this.canvas.pixels[offset + 3] = a;
  }
}

function roiSampleWithSideImage(): RoiSample {
  const bitmap = roiBitmapWithSideImage();

  return {
    id: "sample_1",
    sessionId: "session_1",
    frameId: "frame_1",
    timestampSec: 1,
    frameIndex: 1,
    roiRect: { x: 0, y: 0, width: bitmap.width, height: bitmap.height },
    image: {
      width: bitmap.width,
      height: bitmap.height,
      bitmapRef: bitmap as unknown as HTMLCanvasElement
    }
  };
}

function roiBitmapWithSideImage(): FakeBitmap {
  const width = 200;
  const height = 80;
  const bitmap = blankBitmap(width, height);

  for (const y of [24, 28, 32, 36, 40]) {
    for (let x = 8; x < 140; x += 1) {
      setBitmapPixel(bitmap, x, y, 0);
    }
  }

  for (let y = 8; y < 72; y += 1) {
    for (let x = 154; x < 196; x += 1) {
      setBitmapPixel(bitmap, x, y, x % 7 < 3 ? 20 : 230);
    }
  }

  return bitmap;
}

function roiBitmapWithEndOverlay(): FakeBitmap {
  const width = 200;
  const height = 80;
  const bitmap = blankBitmap(width, height);

  for (let y = 8; y < 72; y += 1) {
    for (let x = 45; x < 155; x += 1) {
      setBitmapPixel(bitmap, x, y, 0);
    }
  }

  return bitmap;
}

function roiBitmapForOccurrenceKind(kind: "A" | "B" | "C"): FakeBitmap {
  const width = 200;
  const height = 80;
  const bitmap = blankBitmap(width, height);
  const noteRanges = {
    A: [{ left: 48, right: 58, top: 26, bottom: 40 }],
    B: [
      { left: 26, right: 42, top: 21, bottom: 44 },
      { left: 98, right: 116, top: 29, bottom: 48 }
    ],
    C: [
      { left: 62, right: 76, top: 18, bottom: 33 },
      { left: 130, right: 148, top: 35, bottom: 54 }
    ]
  } satisfies Record<"A" | "B" | "C", readonly { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number }[]>;

  for (const y of [24, 28, 32, 36, 40]) {
    for (let x = 8; x < 184; x += 1) {
      setBitmapPixel(bitmap, x, y, 0);
    }
  }

  for (const range of noteRanges[kind]) {
    for (let y = range.top; y < range.bottom; y += 1) {
      for (let x = range.left; x < range.right; x += 1) {
        setBitmapPixel(bitmap, x, y, 0);
      }
    }
  }

  return bitmap;
}

function frameWithBitmap(id: string, bitmap: FakeBitmap, roiConfig: ScoreRoiConfig, nearEnd: boolean) {
  return {
    id,
    sessionId: "session_1",
    source: {
      platform: "youtube" as const,
      videoId: "video_1",
      url: "https://www.youtube.com/watch?v=video_1",
      title: "Synthetic"
    },
    timing: {
      timestampSec: nearEnd ? 118 : 1,
      sampledAt: new Date(0).toISOString(),
      frameIndex: nearEnd ? 2 : 1,
      playbackRate: 1
    },
    image: {
      width: bitmap.width,
      height: bitmap.height,
      bitmapRef: bitmap as unknown as HTMLCanvasElement
    },
    meta: {
      sampleIntervalMs: 1000,
      tabId: 1,
      durationSec: 120,
      nearEnd,
      videoEnded: false,
      roiConfig
    }
  };
}

function scoreLike(input: {
  readonly id: string;
  readonly clusterId: string;
  readonly firstSeenSec: number;
  readonly lastSeenSec: number;
  readonly order: number;
  readonly seenCount: number;
}) {
  return {
    ...input,
    sessionId: "session_1",
    imageDataUrl: `data:image/png;mock,${input.id}`,
    width: 100,
    height: 40,
    qualityScore: 0.75
  };
}

function blankBitmap(width: number, height: number): FakeBitmap {
  const bitmap = {
    width,
    height,
    pixels: new Uint8ClampedArray(width * height * 4)
  };

  for (let index = 0; index < bitmap.pixels.length; index += 4) {
    bitmap.pixels[index] = 255;
    bitmap.pixels[index + 1] = 255;
    bitmap.pixels[index + 2] = 255;
    bitmap.pixels[index + 3] = 255;
  }

  return bitmap;
}

function setBitmapPixel(bitmap: FakeBitmap, x: number, y: number, value: number): void {
  const offset = (y * bitmap.width + x) * 4;
  bitmap.pixels[offset] = value;
  bitmap.pixels[offset + 1] = value;
  bitmap.pixels[offset + 2] = value;
  bitmap.pixels[offset + 3] = 255;
}

function countDarkRgbaPixels(pixels: Uint8ClampedArray): number {
  let count = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if ((pixels[index] ?? 255) < 20 && (pixels[index + 1] ?? 255) < 20 && (pixels[index + 2] ?? 255) < 20) {
      count += 1;
    }
  }
  return count;
}

type FrameMessageForTest = {
  uniqueScores?: Array<{ clusterId: string; image: { width: number; height: number; dataUrl?: string } }>;
  exportOccurrences?: Array<{ clusterId: string; occurrenceId: string; occurrenceOrder: number; image: { dataUrl?: string } }>;
  exportCandidates?: Array<{ image: { dataUrl?: string }; qualityScore: number }>;
  identity?: { endGate?: string; exported?: boolean };
};

function isFrameMessage(message: unknown): message is FrameMessageForTest {
  return typeof message === "object" && message !== null && "type" in message && (message as { type?: unknown }).type === "FRAME_SAMPLED";
}

function countScoreDataUrls(message: FrameMessageForTest): number {
  return [
    ...(message.uniqueScores ?? []),
    ...(message.exportOccurrences ?? []),
    ...(message.exportCandidates ?? [])
  ].filter((score) => Boolean(score.image.dataUrl)).length;
}
