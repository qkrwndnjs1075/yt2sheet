import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { compactCaptureImages, hydrateCaptureImages } from "../src/background/capture-image-state.js";
import { CaptureImageStorage } from "../src/background/capture-image-storage.js";
import type { DebugCaptureState } from "../src/shared/debug-state.js";
import type { DebugUniqueScore } from "../src/shared/messages.js";

test("full score images are deduplicated outside the bounded session state", () => {
  const scores = Array.from({ length: 20 }, (_, index) => score(index + 1, 220_000));
  const state: DebugCaptureState = {
    currentSession: null,
    lastCompletedSession: null,
    recentFrames: [],
    uniqueScores: scores,
    exportOccurrences: scores.map((item, index) => ({
      ...item,
      occurrenceId: `occurrence_${index + 1}`,
      occurrenceOrder: index + 1
    })),
    exportCandidates: scores,
    lastError: null,
    updatedAt: new Date(0).toISOString()
  };

  assert.ok(JSON.stringify(state).length > 10_485_760, "the previous duplicated state must exceed Chrome's 10 MB session quota");

  const compacted = compactCaptureImages(state);
  assert.ok(JSON.stringify(compacted.state).length < 100_000, "session state must remain metadata-only");
  assert.equal(Object.keys(compacted.images).length, scores.length, "shared occurrence/candidate images must be stored once");
  assert.ok(compacted.state.uniqueScores.every((item) => item.image.dataUrl === undefined));
  assert.deepEqual(hydrateCaptureImages(compacted.state, compacted.images), state);
});

test("sampling errors reset only after frame delivery succeeds", () => {
  const source = readFileSync(resolve(process.cwd(), "src/offscreen/frame-input-collector.ts"), "utf8");
  const sampleFrame = source.slice(source.indexOf("private async sampleFrame"), source.indexOf("private currentTimestampSec"));
  const deliveryIndex = sampleFrame.indexOf("await this.sink?.onFrame(frame);");
  const resetIndex = sampleFrame.indexOf("current.consecutiveSampleErrors = 0;");

  assert.notEqual(deliveryIndex, -1);
  assert.notEqual(resetIndex, -1);
  assert.ok(resetIndex > deliveryIndex, "a rejected sink delivery must count as consecutive failure");
});

test("capture image storage writes each immutable image once and hydrates it for review", async () => {
  const storage = new FakeStorage();
  const repository = new CaptureImageStorage(storage);
  const state: DebugCaptureState = {
    currentSession: null,
    lastCompletedSession: null,
    recentFrames: [],
    uniqueScores: [score(1, 100)],
    exportCandidates: [score(1, 100)],
    lastError: null,
    updatedAt: new Date(0).toISOString()
  };

  const compacted = await repository.persist(state);
  await repository.persist(state);

  assert.equal(storage.setCalls, 1, "unchanged cumulative frame payloads must not rewrite existing images");
  assert.equal(compacted.uniqueScores[0]?.image.dataUrl, undefined);
  assert.deepEqual(await repository.hydrate(compacted), state);

  storage.values.set("unrelated-setting", true);
  await repository.clear();
  assert.equal(storage.values.get("unrelated-setting"), true, "capture cleanup must preserve unrelated local settings");
  assert.equal([...storage.values.keys()].some((key) => key.startsWith("capture-image:")), false);
});

test("extension requests unbounded local storage for long capture image data", () => {
  const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "manifest.json"), "utf8")) as { permissions?: string[] };
  assert.ok(manifest.permissions?.includes("unlimitedStorage"));
});

test("two-minute cumulative capture keeps session state below quota and restores every score", async () => {
  const storage = new FakeStorage();
  const repository = new CaptureImageStorage(storage);
  let compacted: DebugCaptureState | undefined;

  for (let second = 1; second <= 120; second += 1) {
    const scores = Array.from({ length: second }, (_, index) => score(index + 1, 20_000));
    compacted = await repository.persist({
      currentSession: null,
      lastCompletedSession: null,
      recentFrames: [],
      uniqueScores: scores,
      exportOccurrences: scores.map((item, index) => ({
        ...item,
        occurrenceId: `occurrence_${index + 1}`,
        occurrenceOrder: index + 1
      })),
      exportCandidates: scores,
      lastError: null,
      updatedAt: new Date(second * 1000).toISOString()
    });
  }

  assert.ok(compacted);
  assert.ok(JSON.stringify(compacted).length < 1_000_000, "two minutes of metadata must stay far below 10 MB");
  assert.equal(storage.setCalls, 120, "each second adds only its one new image");
  const hydrated = await repository.hydrate(compacted);
  assert.equal(hydrated.uniqueScores.length, 120);
  assert.ok(hydrated.uniqueScores.every((item) => item.image.dataUrl?.startsWith("data:image/png;base64,")));
});

function score(index: number, dataLength: number): DebugUniqueScore {
  return {
    id: `score_${index}`,
    sessionId: "session_1",
    clusterId: `cluster_${index}`,
    source: {
      videoId: "video_1",
      url: "https://www.youtube.com/watch?v=video_1",
      firstSeenSec: index,
      lastSeenSec: index,
      seenCount: 1
    },
    image: {
      imageBlobId: `image_${index}`,
      width: 1200,
      height: 320,
      dataUrl: `data:image/png;base64,${"a".repeat(dataLength)}`
    },
    qualityScore: 1,
    order: index
  };
}

class FakeStorage {
  readonly values = new Map<string, unknown>();
  setCalls = 0;

  async get(keys: string | string[] | null = null): Promise<Record<string, unknown>> {
    const selected = keys === null ? [...this.values.keys()] : Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(selected.flatMap((key) => this.values.has(key) ? [[key, this.values.get(key)]] : []));
  }

  async set(items: Record<string, unknown>): Promise<void> {
    this.setCalls += 1;
    Object.entries(items).forEach(([key, value]) => this.values.set(key, value));
  }

  async remove(keys: string | string[]): Promise<void> {
    (Array.isArray(keys) ? keys : [keys]).forEach((key) => this.values.delete(key));
  }
}
