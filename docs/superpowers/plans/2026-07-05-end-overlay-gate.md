# End Overlay Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent YouTube end-screen/profile overlays from becoming exported score systems while preserving real final score changes after two confirmations.

**Architecture:** Add a rule-first `EndCandidateGate` around ROI identity clustering. Normal samples continue through `ScoreClusterer`; near-end `different` samples are held as `pending_end_candidate`, accepted only after a second matching score-like sample, and otherwise kept debug-only/export-excluded.

**Tech Stack:** TypeScript, Chrome MV3 runtime messaging, local canvas/image heuristics, Node test runner, Vite, existing ROI fingerprint/cluster pipeline.

## Global Constraints

- Do not add default AI, Gemini, Claude, or network API judgment.
- Do not discard every frame near the end unconditionally.
- Do not add a user-facing confirmation dialog in the first implementation.
- Do not change the PDF/PNG export file format.
- Do not persist raw full frames.
- `nearEndWindowMs` defaults to `3000`.
- `endCandidateRequiredConfirmations` defaults to `2`.
- `maxEndCandidateCropAreaDiff` defaults to `0.40`.
- `maxEndCandidateInkDensityDiff` defaults to `0.18`.
- `maxOverlayDominantRegionRatio` defaults to `0.35`.
- Run `npm run verify` before reporting completion.

---

## File Structure

- Modify `src/shared/score-identity-config.ts`
  - Add end-gate config constants.
- Modify `src/shared/roi-types.ts`
  - Extend debug metadata with end-gate fields.
- Modify `src/shared/types.ts`
  - Carry `durationSec`, `nearEnd`, and `videoEnded` through `InputFrame.meta`.
- Modify `src/offscreen/frame-input-collector.ts`
  - Populate end-aware frame metadata from latest video tick.
- Modify `src/offscreen/identity/staff-content-extractor.ts`
  - Export staff-row run detection for metrics reuse.
- Create `src/offscreen/identity/end-candidate-metrics.ts`
  - Compute score-likeness and overlay contamination metrics from normalized ROI images.
- Create `src/offscreen/identity/end-candidate-gate.ts`
  - Hold, confirm, discard, or pass through end-sensitive samples.
- Modify `src/offscreen/identity/score-clusterer.ts`
  - Add a non-mutating preview method and a public confirmed-cluster path needed by the gate.
- Modify `src/shared/cluster-types.ts`
  - Add optional end-gate status/debug fields to `ScoreClusterUpdate`.
- Modify `src/offscreen/debug-frame-sink.ts`
  - Route ROI samples through `EndCandidateGate`, store representative images only for exported updates, and emit debug metadata.
- Test `tests/end-candidate-gate.test.ts`
  - Unit tests for held, confirmed, overlay-discarded, and unconfirmed final candidate behavior.
- Test `tests/debug-frame-sink.test.ts`
  - Integration-style debug metadata and export exclusion checks.
- Test `tests/roi-identity.test.ts`
  - Regression tests for normal clustering unchanged.

---

### Task 1: Add End-Gate Configuration and Debug Types

**Files:**
- Modify: `src/shared/score-identity-config.ts`
- Modify: `src/shared/roi-types.ts`
- Modify: `src/shared/cluster-types.ts`
- Test: `tests/roi-identity.test.ts`

**Interfaces:**
- Produces: `SCORE_IDENTITY_CONFIG.endGate`
- Produces: `EndGateStatus`
- Produces: optional `endGate`, `exported`, `pendingEndCandidateCount`, and `endGateReason` fields on debug/update types.

- [ ] **Step 1: Write the failing config/type test**

Add this test to `tests/roi-identity.test.ts` near the existing config-oriented tests:

```ts
import { SCORE_IDENTITY_CONFIG } from "../src/shared/score-identity-config.js";
```

```ts
test("end gate config uses rule-first two-confirmation defaults", () => {
  assert.equal(SCORE_IDENTITY_CONFIG.endGate.nearEndWindowMs, 3000);
  assert.equal(SCORE_IDENTITY_CONFIG.endGate.endCandidateRequiredConfirmations, 2);
  assert.equal(SCORE_IDENTITY_CONFIG.endGate.maxEndCandidateCropAreaDiff, 0.4);
  assert.equal(SCORE_IDENTITY_CONFIG.endGate.maxEndCandidateInkDensityDiff, 0.18);
  assert.equal(SCORE_IDENTITY_CONFIG.endGate.maxOverlayDominantRegionRatio, 0.35);
});
```

- [ ] **Step 2: Run the targeted test and verify failure**

Run:

```bash
npm test -- --test-name-pattern "end gate config uses rule-first two-confirmation defaults"
```

Expected: TypeScript compile fails because `SCORE_IDENTITY_CONFIG.endGate` does not exist.

- [ ] **Step 3: Add config constants**

In `src/shared/score-identity-config.ts`, add this top-level section after `cluster` and before `page`:

```ts
  endGate: {
    nearEndWindowMs: 3000,
    endCandidateRequiredConfirmations: 2,
    maxEndCandidateCropAreaDiff: 0.4,
    maxEndCandidateInkDensityDiff: 0.18,
    maxOverlayDominantRegionRatio: 0.35
  },
```

- [ ] **Step 4: Add end-gate status/debug types**

In `src/shared/roi-types.ts`, add this exported type above `RoiIdentityDebugInfo`:

```ts
export type EndGateStatus =
  | "none"
  | "held"
  | "confirmed"
  | "discarded_overlay"
  | "discarded_unconfirmed";
```

Then extend `RoiIdentityDebugInfo`:

```ts
  endGate?: EndGateStatus;
  endGateReason?: string;
  exported?: boolean;
  pendingEndCandidateCount?: number;
```

In `src/shared/cluster-types.ts`, import `EndGateStatus`:

```ts
import type { EndGateStatus, RoiSample } from "./roi-types";
```

Then extend `ScoreClusterUpdate`:

```ts
  endGate?: EndGateStatus;
  endGateReason?: string;
  exported?: boolean;
  pendingEndCandidateCount?: number;
```

- [ ] **Step 5: Run the targeted test and verify pass**

Run:

```bash
npm test -- --test-name-pattern "end gate config uses rule-first two-confirmation defaults"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/score-identity-config.ts src/shared/roi-types.ts src/shared/cluster-types.ts tests/roi-identity.test.ts
git commit -m "feat: add end gate config and debug types"
```

---

### Task 2: Add Score-Likeness Metrics for End Candidates

**Files:**
- Modify: `src/offscreen/identity/staff-content-extractor.ts`
- Create: `src/offscreen/identity/end-candidate-metrics.ts`
- Test: `tests/end-candidate-gate.test.ts`

**Interfaces:**
- Consumes: `NormalizedScoreImage`
- Produces:
  - `EndCandidateMetrics`
  - `measureEndCandidate(image: NormalizedScoreImage): EndCandidateMetrics`
  - `isScoreLikeEndCandidate(current, previous, config): boolean`

- [ ] **Step 1: Write the failing metrics tests**

Create `tests/end-candidate-gate.test.ts` with:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { isScoreLikeEndCandidate, measureEndCandidate } from "../src/offscreen/identity/end-candidate-metrics.js";
import { createNormalizedImage } from "../src/offscreen/identity/score-normalizer.js";
import { SCORE_IDENTITY_CONFIG } from "../src/shared/score-identity-config.js";

test("end candidate metrics accept stable score-like staff content", () => {
  const previous = measureEndCandidate(scoreImage());
  const current = measureEndCandidate(scoreImage());

  assert.equal(current.staffRowRunCount >= 3, true);
  assert.equal(isScoreLikeEndCandidate(current, previous, SCORE_IDENTITY_CONFIG.endGate), true);
});

test("end candidate metrics reject dominant overlay contamination", () => {
  const previous = measureEndCandidate(scoreImage());
  const current = measureEndCandidate(overlayImage());

  assert.equal(isScoreLikeEndCandidate(current, previous, SCORE_IDENTITY_CONFIG.endGate), false);
  assert.equal(current.dominantRegionRatio > SCORE_IDENTITY_CONFIG.endGate.maxOverlayDominantRegionRatio, true);
});

function scoreImage() {
  const width = 160;
  const height = 80;
  const pixels = new Array<number>(width * height).fill(255);

  for (const y of [24, 28, 32, 36, 40]) {
    for (let x = 8; x < 148; x += 1) {
      pixels[y * width + x] = 0;
    }
  }

  for (let y = 26; y < 40; y += 1) {
    for (let x = 74; x < 84; x += 1) {
      pixels[y * width + x] = 0;
    }
  }

  return createNormalizedImage(width, height, pixels);
}

function overlayImage() {
  const width = 160;
  const height = 80;
  const pixels = new Array<number>(width * height).fill(255);

  for (let y = 8; y < 72; y += 1) {
    for (let x = 20; x < 140; x += 1) {
      pixels[y * width + x] = 30;
    }
  }

  return createNormalizedImage(width, height, pixels);
}
```

- [ ] **Step 2: Run the targeted test and verify failure**

Run:

```bash
npm test -- --test-name-pattern "end candidate metrics"
```

Expected: TypeScript compile fails because `end-candidate-metrics.ts` does not exist.

- [ ] **Step 3: Export reusable staff-row detection**

In `src/offscreen/identity/staff-content-extractor.ts`, change:

```ts
function detectStaffRowRuns(width: number, height: number, pixelAt: (x: number, y: number) => number): Array<{ y: number; startX: number; endX: number }> {
```

to:

```ts
export function detectStaffRowRuns(width: number, height: number, pixelAt: (x: number, y: number) => number): Array<{ y: number; startX: number; endX: number }> {
```

- [ ] **Step 4: Create metrics implementation**

Create `src/offscreen/identity/end-candidate-metrics.ts`:

```ts
import type { NormalizedScoreImage } from "../../shared/fingerprint-types";
import type { SCORE_IDENTITY_CONFIG } from "../../shared/score-identity-config";
import { detectStaffRowRuns, findStaffContentRect, type PixelRect } from "./staff-content-extractor";

const DARK_THRESHOLD = 150;

export type EndCandidateMetrics = {
  staffRowRunCount: number;
  staffContentRect: PixelRect;
  staffContentAreaRatio: number;
  inkDensity: number;
  dominantRegionRatio: number;
};

export type EndGateThresholds = typeof SCORE_IDENTITY_CONFIG.endGate;

export function measureEndCandidate(image: NormalizedScoreImage): EndCandidateMetrics {
  const pixelAt = (x: number, y: number) => image.pixels[y * image.width + x] ?? 255;
  const staffRows = detectStaffRowRuns(image.width, image.height, pixelAt);
  const staffContentRect = findStaffContentRect(image.width, image.height, pixelAt);
  const totalArea = Math.max(1, image.width * image.height);

  return {
    staffRowRunCount: staffRows.length,
    staffContentRect,
    staffContentAreaRatio: (staffContentRect.width * staffContentRect.height) / totalArea,
    inkDensity: calculateInkDensity(image),
    dominantRegionRatio: calculateDominantRegionRatio(image)
  };
}

export function isScoreLikeEndCandidate(
  current: EndCandidateMetrics,
  previous: EndCandidateMetrics | null,
  thresholds: EndGateThresholds
): boolean {
  if (current.staffRowRunCount < 3) {
    return false;
  }

  if (current.dominantRegionRatio > thresholds.maxOverlayDominantRegionRatio) {
    return false;
  }

  if (!previous) {
    return true;
  }

  if (Math.abs(current.staffContentAreaRatio - previous.staffContentAreaRatio) > thresholds.maxEndCandidateCropAreaDiff) {
    return false;
  }

  if (Math.abs(current.inkDensity - previous.inkDensity) > thresholds.maxEndCandidateInkDensityDiff) {
    return false;
  }

  return true;
}

function calculateInkDensity(image: NormalizedScoreImage): number {
  let dark = 0;
  for (const pixel of image.pixels) {
    if (pixel < DARK_THRESHOLD) {
      dark += 1;
    }
  }
  return dark / Math.max(1, image.pixels.length);
}

function calculateDominantRegionRatio(image: NormalizedScoreImage): number {
  const visited = new Uint8Array(image.width * image.height);
  let largest = 0;

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const index = y * image.width + x;
      if (visited[index] || (image.pixels[index] ?? 255) >= DARK_THRESHOLD) {
        continue;
      }
      largest = Math.max(largest, floodFillDarkRegion(image, x, y, visited));
    }
  }

  return largest / Math.max(1, image.width * image.height);
}

function floodFillDarkRegion(image: NormalizedScoreImage, startX: number, startY: number, visited: Uint8Array): number {
  const stack: Array<[number, number]> = [[startX, startY]];
  let count = 0;

  while (stack.length > 0) {
    const [x, y] = stack.pop() as [number, number];
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) {
      continue;
    }

    const index = y * image.width + x;
    if (visited[index] || (image.pixels[index] ?? 255) >= DARK_THRESHOLD) {
      continue;
    }

    visited[index] = 1;
    count += 1;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }

  return count;
}
```

- [ ] **Step 5: Run metrics tests and verify pass**

Run:

```bash
npm test -- --test-name-pattern "end candidate metrics"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/offscreen/identity/staff-content-extractor.ts src/offscreen/identity/end-candidate-metrics.ts tests/end-candidate-gate.test.ts
git commit -m "feat: add end candidate metrics"
```

---

### Task 3: Add Non-Mutating Match Preview to ScoreClusterer

**Files:**
- Modify: `src/offscreen/identity/score-clusterer.ts`
- Test: `tests/end-candidate-gate.test.ts`

**Interfaces:**
- Produces: `ScoreClusterer.previewFingerprint(fingerprint: ScoreFingerprint): { decision: "same" | "maybe_same" | "different"; matchedClusterId?: string; similarity?: ScoreSimilarityDebug }`
- Produces: `ScoreClusterer.confirmDifferent(input: ClusterInput): ScoreClusterUpdate`

- [ ] **Step 1: Write failing clusterer preview test**

Append to `tests/end-candidate-gate.test.ts`:

```ts
import { ScoreClusterer } from "../src/offscreen/identity/score-clusterer.js";
import type { ScoreFingerprint } from "../src/shared/fingerprint-types.js";
import type { RoiSample } from "../src/shared/roi-types.js";

test("clusterer preview does not mutate accepted clusters", () => {
  const clusterer = new ScoreClusterer();
  clusterer.addSample(sample(1), fingerprint("A"), 0.5);

  const preview = clusterer.previewFingerprint(fingerprint("B"));

  assert.equal(preview.decision, "different");
  assert.equal(clusterer.getAcceptedClusters().length, 1);
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

function fingerprint(kind: "A" | "B"): ScoreFingerprint {
  if (kind === "A") {
    return {
      fullPHash: "0000000000000000",
      fullDHash: "0000000000000000",
      contentPHash: "0000000000000000",
      contentDHash: "0000000000000000",
      horizontalProjection: new Array<number>(32).fill(0.2),
      verticalProjection: new Array<number>(64).fill(0.2),
      aspectRatio: 3.2,
      inkDensity: 0.18
    };
  }

  return {
    fullPHash: "ffffffffffffffff",
    fullDHash: "ffffffffffffffff",
    contentPHash: "ffffffffffffffff",
    contentDHash: "ffffffffffffffff",
    horizontalProjection: Array.from({ length: 32 }, (_value, index) => (index % 2 === 0 ? 0.01 : 0.8)),
    verticalProjection: Array.from({ length: 64 }, (_value, index) => (index % 2 === 0 ? 0.01 : 0.8)),
    aspectRatio: 3.2,
    inkDensity: 0.42
  };
}
```

- [ ] **Step 2: Run targeted test and verify failure**

Run:

```bash
npm test -- --test-name-pattern "clusterer preview does not mutate accepted clusters"
```

Expected: TypeScript compile fails because `previewFingerprint` does not exist.

- [ ] **Step 3: Add preview and explicit confirm methods**

In `src/offscreen/identity/score-clusterer.ts`, add these public methods after `handleFingerprint`:

```ts
  previewFingerprint(fingerprint: ScoreFingerprint): {
    decision: "same" | "maybe_same" | "different";
    matchedClusterId?: string;
    similarity?: ScoreSimilarityDebug;
  } {
    const match = this.findMatch(fingerprint);

    if (!match) {
      return { decision: "different" };
    }

    return {
      decision: match.similarity.decision,
      matchedClusterId: match.cluster.id,
      similarity: match.similarity
    };
  }

  confirmDifferent(input: ClusterInput): ScoreClusterUpdate {
    const cluster = this.createCluster(input);
    this.activeClusterId = cluster.id;
    return this.toUpdate("different", input.sample, {
      cluster,
      newClusterId: cluster.id,
      representativeSample: input.sample,
      exported: true
    });
  }
```

Then update `handleFingerprint` to use `exported: true` for normal paths:

```ts
return this.toUpdate("same", input.sample, {
  cluster,
  matchedClusterId: cluster.id,
  representativeSample: cluster.representativeSampleId !== previousRepresentativeId ? input.sample : undefined,
  previousRepresentativeImageBlobId: cluster.representativeImageBlobId !== previousRepresentativeImageBlobId ? previousRepresentativeImageBlobId : undefined,
  similarity: match.similarity,
  exported: true
});
```

Apply the same `exported: true` patch to normal accepted `same` and `different` returns. Leave `maybe_same` pending returns as `exported: false`.

- [ ] **Step 4: Run preview test and existing cluster tests**

Run:

```bash
npm test -- --test-name-pattern "clusterer preview|A,A,A,B,B,C|maybe_same|cluster representative"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/offscreen/identity/score-clusterer.ts tests/end-candidate-gate.test.ts
git commit -m "feat: add clusterer preview for end gate"
```

---

### Task 4: Implement EndCandidateGate

**Files:**
- Create: `src/offscreen/identity/end-candidate-gate.ts`
- Test: `tests/end-candidate-gate.test.ts`

**Interfaces:**
- Consumes:
  - `ScoreClusterer.previewFingerprint`
  - `ScoreClusterer.handleFingerprint`
  - `ScoreClusterer.confirmDifferent`
  - `EndCandidateMetrics`
- Produces:
  - `EndCandidateGate.handle(input: EndCandidateGateInput): ScoreClusterUpdate`
  - `EndCandidateGate.flushUnconfirmed(sessionId: string): ScoreClusterUpdate | null`
  - `EndCandidateGate.pendingCount(): number`

- [ ] **Step 1: Add failing gate behavior tests**

Append these tests to `tests/end-candidate-gate.test.ts`:

```ts
import { EndCandidateGate } from "../src/offscreen/identity/end-candidate-gate.js";

test("end gate holds one near-end different score candidate", () => {
  const clusterer = new ScoreClusterer();
  const gate = new EndCandidateGate(clusterer);
  const previousMetrics = measureEndCandidate(scoreImage());

  gate.handle(input(1, "A", false, previousMetrics));
  const held = gate.handle(input(2, "B", true, previousMetrics));

  assert.equal(held.endGate, "held");
  assert.equal(held.exported, false);
  assert.equal(clusterer.getAcceptedClusters().length, 1);
});

test("end gate confirms a near-end different score after two matching samples", () => {
  const clusterer = new ScoreClusterer();
  const gate = new EndCandidateGate(clusterer);
  const previousMetrics = measureEndCandidate(scoreImage());

  gate.handle(input(1, "A", false, previousMetrics));
  gate.handle(input(2, "B", true, previousMetrics));
  const confirmed = gate.handle(input(3, "B", true, previousMetrics));

  assert.equal(confirmed.endGate, "confirmed");
  assert.equal(confirmed.exported, true);
  assert.equal(clusterer.getAcceptedClusters().length, 2);
});

test("end gate excludes one unconfirmed final candidate from export", () => {
  const clusterer = new ScoreClusterer();
  const gate = new EndCandidateGate(clusterer);
  const previousMetrics = measureEndCandidate(scoreImage());

  gate.handle(input(1, "A", false, previousMetrics));
  gate.handle(input(2, "B", true, previousMetrics));
  const flushed = gate.flushUnconfirmed("session_1");

  assert.equal(flushed?.endGate, "discarded_unconfirmed");
  assert.equal(flushed?.exported, false);
  assert.equal(clusterer.getAcceptedClusters().length, 1);
});

test("end gate discards near-end overlay contamination", () => {
  const clusterer = new ScoreClusterer();
  const gate = new EndCandidateGate(clusterer);
  const previousMetrics = measureEndCandidate(scoreImage());
  const overlayMetrics = measureEndCandidate(overlayImage());

  gate.handle(input(1, "A", false, previousMetrics));
  const discarded = gate.handle(input(2, "B", true, overlayMetrics));

  assert.equal(discarded.endGate, "discarded_overlay");
  assert.equal(discarded.exported, false);
  assert.equal(clusterer.getAcceptedClusters().length, 1);
});

function input(index: number, kind: "A" | "B", nearEnd: boolean, metrics: ReturnType<typeof measureEndCandidate>) {
  return {
    sample: sample(index),
    fingerprint: fingerprint(kind),
    qualityScore: 0.8,
    imageBlobId: `roi-representative:sample_${index}`,
    nearEnd,
    videoEnded: false,
    metrics,
    previousAcceptedMetrics: kind === "A" ? null : measureEndCandidate(scoreImage())
  };
}
```

- [ ] **Step 2: Run gate tests and verify failure**

Run:

```bash
npm test -- --test-name-pattern "end gate"
```

Expected: TypeScript compile fails because `EndCandidateGate` does not exist.

- [ ] **Step 3: Implement EndCandidateGate**

Create `src/offscreen/identity/end-candidate-gate.ts`:

```ts
import type { ScoreClusterUpdate } from "../../shared/cluster-types";
import { SCORE_IDENTITY_CONFIG } from "../../shared/score-identity-config";
import type { ClusterInput } from "./score-clusterer";
import { ScoreClusterer } from "./score-clusterer";
import { compareScoreFingerprints } from "./score-similarity";
import type { EndCandidateMetrics } from "./end-candidate-metrics";
import { isScoreLikeEndCandidate } from "./end-candidate-metrics";

export type EndCandidateGateInput = ClusterInput & {
  nearEnd: boolean;
  videoEnded: boolean;
  metrics: EndCandidateMetrics;
  previousAcceptedMetrics: EndCandidateMetrics | null;
};

type PendingEndCandidate = EndCandidateGateInput & {
  confirmationCount: number;
};

export class EndCandidateGate {
  private pending: PendingEndCandidate | null = null;

  constructor(private readonly clusterer: ScoreClusterer) {}

  handle(input: EndCandidateGateInput): ScoreClusterUpdate {
    if (!input.nearEnd && !input.videoEnded) {
      return this.withEndGate(this.clusterer.handleFingerprint(input), "none", true);
    }

    const preview = this.clusterer.previewFingerprint(input.fingerprint);
    if (preview.decision === "same" || preview.decision === "maybe_same") {
      return this.withEndGate(this.clusterer.handleFingerprint(input), "none", true);
    }

    if (!isScoreLikeEndCandidate(input.metrics, input.previousAcceptedMetrics, SCORE_IDENTITY_CONFIG.endGate)) {
      this.pending = null;
      return this.syntheticUpdate(input, "discarded_overlay", "end candidate failed score-like metrics", false);
    }

    if (!this.pending) {
      this.pending = { ...input, confirmationCount: 1 };
      return this.syntheticUpdate(input, "held", "near-end different candidate needs confirmation", false);
    }

    const currentToPending = compareScoreFingerprints(input.fingerprint, this.pending.fingerprint);
    if (currentToPending.decision === "same") {
      const first = this.pending;
      this.pending = null;
      this.clusterer.confirmDifferent(first);
      const confirmed = this.clusterer.handleFingerprint(input);
      return this.withEndGate(confirmed, "confirmed", true);
    }

    this.pending = { ...input, confirmationCount: 1 };
    return this.syntheticUpdate(input, "held", "near-end candidate replaced by a newer different candidate", false);
  }

  flushUnconfirmed(sessionId: string): ScoreClusterUpdate | null {
    if (!this.pending || this.pending.sample.sessionId !== sessionId) {
      return null;
    }

    const pending = this.pending;
    this.pending = null;
    return this.syntheticUpdate(pending, "discarded_unconfirmed", "capture stopped before end candidate confirmation", false);
  }

  pendingCount(): number {
    return this.pending ? 1 : 0;
  }

  private withEndGate(update: ScoreClusterUpdate, endGate: ScoreClusterUpdate["endGate"], exported: boolean): ScoreClusterUpdate {
    return {
      ...update,
      endGate,
      exported,
      pendingEndCandidateCount: this.pendingCount()
    };
  }

  private syntheticUpdate(
    input: EndCandidateGateInput,
    endGate: NonNullable<ScoreClusterUpdate["endGate"]>,
    endGateReason: string,
    exported: boolean
  ): ScoreClusterUpdate {
    return {
      decision: "different",
      sample: input.sample,
      endGate,
      endGateReason,
      exported,
      clusters: this.clusterer.getClusters(),
      acceptedClusters: this.clusterer.getAcceptedClusters(),
      pendingCount: this.clusterer.getPendingCount(),
      pendingEndCandidateCount: this.pendingCount()
    };
  }
}
```

- [ ] **Step 4: Run gate tests and verify pass**

Run:

```bash
npm test -- --test-name-pattern "end gate"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/offscreen/identity/end-candidate-gate.ts tests/end-candidate-gate.test.ts
git commit -m "feat: add end candidate gate"
```

---

### Task 5: Carry End Timing Metadata to Offscreen Frames

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/offscreen/frame-input-collector.ts`
- Test: `tests/debug-frame-sink.test.ts`

**Interfaces:**
- Produces:
  - `InputFrame.meta.durationSec?: number | null`
  - `InputFrame.meta.nearEnd?: boolean`
  - `InputFrame.meta.videoEnded?: boolean`

- [ ] **Step 1: Write failing metadata test**

Add a focused type-level test to `tests/debug-frame-sink.test.ts`:

```ts
import type { OffscreenInputFrame } from "../src/offscreen/frame-sink.js";

test("offscreen frame metadata can carry end timing flags", () => {
  const frame = {
    id: "frame_1",
    sessionId: "session_1",
    source: {
      platform: "youtube",
      videoId: "video_1",
      url: "https://www.youtube.com/watch?v=video_1",
      title: "Synthetic"
    },
    timing: {
      timestampSec: 98,
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
      tabId: 1,
      durationSec: 100,
      nearEnd: true,
      videoEnded: false
    }
  } satisfies OffscreenInputFrame;

  assert.equal(frame.meta.nearEnd, true);
});
```

- [ ] **Step 2: Run targeted test and verify failure**

Run:

```bash
npm test -- --test-name-pattern "offscreen frame metadata can carry end timing flags"
```

Expected: TypeScript compile fails because `durationSec`, `nearEnd`, and `videoEnded` are not in `InputFrame.meta`.

- [ ] **Step 3: Extend InputFrame meta**

In `src/shared/types.ts`, extend `InputFrame.meta`:

```ts
    durationSec?: number | null;
    nearEnd?: boolean;
    videoEnded?: boolean;
```

- [ ] **Step 4: Populate metadata in FrameInputCollector**

In `src/offscreen/frame-input-collector.ts`, add this helper near the bottom before `waitForVideo`:

```ts
function isNearEnd(timestampSec: number, durationSec: number | null | undefined): boolean {
  if (durationSec === null || durationSec === undefined) {
    return false;
  }

  const remainingMs = (durationSec - timestampSec) * 1000;
  return remainingMs <= SCORE_IDENTITY_CONFIG.endGate.nearEndWindowMs;
}
```

Import config at the top:

```ts
import { SCORE_IDENTITY_CONFIG } from "../shared/score-identity-config";
```

In the frame `meta` object, add:

```ts
          durationSec: current.session.source.durationSec,
          nearEnd: isNearEnd(timestampSec, current.session.source.durationSec),
          videoEnded: current.session.source.durationSec !== null && timestampSec >= current.session.source.durationSec,
```

- [ ] **Step 5: Run metadata test and typecheck**

Run:

```bash
npm test -- --test-name-pattern "offscreen frame metadata can carry end timing flags"
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/offscreen/frame-input-collector.ts tests/debug-frame-sink.test.ts
git commit -m "feat: carry end timing metadata"
```

---

### Task 6: Integrate EndCandidateGate into DebugFrameSink

**Files:**
- Modify: `src/offscreen/debug-frame-sink.ts`
- Test: `tests/debug-frame-sink.test.ts`

**Interfaces:**
- Consumes: `EndCandidateGate`
- Produces: debug metadata fields in `FrameMetaMessage.identity`
- Ensures: held/discarded end candidates have no representative export image and no unique exported score.

- [ ] **Step 1: Write failing debug/export integration test**

Add this test to `tests/debug-frame-sink.test.ts`:

```ts
test("debug frame sink excludes unconfirmed final candidates from exported unique scores", async () => {
  const sentMessages: unknown[] = [];
  const previousDocument = globalThis.document;
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      sendMessage: async (message: unknown) => {
        sentMessages.push(message);
      }
    }
  };
  (globalThis as { document?: Document }).document = {
    createElement: () => new FakeCanvas()
  } as unknown as Document;

  try {
    const bitmap = roiBitmapWithSideImage();
    const sink = new DebugFrameSink();
    await sink.onSessionStarted(sessionWithRoi(bitmap.width, bitmap.height));
    await sink.onFrame(frameWithBitmap(1, bitmap, false));
    await sink.onFrame(frameWithBitmap(2, bitmap, true));
    await sink.onSessionStopped({ ...sessionWithRoi(bitmap.width, bitmap.height), state: "completed" });

    const frameMessages = sentMessages.filter((message) => isFrameMessage(message));
    const lastFrame = frameMessages.at(-1);
    assert.ok(lastFrame);
    assert.equal(lastFrame.identity?.endGate === "held" || lastFrame.identity?.endGate === "discarded_overlay", true);
    assert.equal(lastFrame.identity?.exported, false);
    assert.equal((lastFrame.uniqueScores ?? []).length, 1);
  } finally {
    (globalThis as { document?: Document }).document = previousDocument;
  }
});
```

Add helpers in the same test file:

```ts
function sessionWithRoi(width: number, height: number): CaptureSession {
  return {
    id: "session_1",
    tabId: 1,
    source: {
      platform: "youtube",
      videoId: "video_1",
      url: "https://www.youtube.com/watch?v=video_1",
      title: "Synthetic",
      durationSec: 3,
      currentTimeSec: 0,
      playbackRate: 1,
      paused: false
    },
    config: {
      sampleIntervalMs: 1000,
      startTimeSec: 0,
      endTimeSec: null,
      captureVideoOnly: true,
      persistRawFrames: false,
      roiConfig: {
        id: "roi_1",
        videoId: "video_1",
        url: "https://www.youtube.com/watch?v=video_1",
        roiRect: { x: 0, y: 0, width, height },
        coordinateSpace: "frame",
        createdAt: new Date(0).toISOString(),
        sampleIntervalMs: 1000
      }
    },
    state: "running",
    stats: {
      framesSampled: 0,
      framesDropped: 0,
      startedAt: new Date(0).toISOString()
    }
  };
}

function frameWithBitmap(index: number, bitmap: FakeBitmap, nearEnd: boolean): OffscreenInputFrame {
  return {
    id: `frame_${index}`,
    sessionId: "session_1",
    source: {
      platform: "youtube",
      videoId: "video_1",
      url: "https://www.youtube.com/watch?v=video_1",
      title: "Synthetic"
    },
    timing: {
      timestampSec: index,
      sampledAt: new Date(index * 1000).toISOString(),
      frameIndex: index,
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
      durationSec: 3,
      nearEnd,
      videoEnded: false,
      roiConfig: sessionWithRoi(bitmap.width, bitmap.height).config.roiConfig
    }
  };
}
```

Add needed imports:

```ts
import type { CaptureSession } from "../src/shared/types.js";
import type { OffscreenInputFrame } from "../src/offscreen/frame-sink.js";
```

- [ ] **Step 2: Run integration test and verify failure**

Run:

```bash
npm test -- --test-name-pattern "debug frame sink excludes unconfirmed final candidates"
```

Expected: FAIL because DebugFrameSink does not use `EndCandidateGate`.

- [ ] **Step 3: Integrate gate in DebugFrameSink**

In `src/offscreen/debug-frame-sink.ts`, add imports:

```ts
import { EndCandidateGate } from "./identity/end-candidate-gate";
import { measureEndCandidate, type EndCandidateMetrics } from "./identity/end-candidate-metrics";
```

Add fields:

```ts
  private readonly endCandidateGate = new EndCandidateGate(this.clusterer);
  private lastAcceptedMetrics: EndCandidateMetrics | null = null;
  private lastEndGateFlush: ScoreClusterUpdate | null = null;
```

In `onSessionStarted`, reset:

```ts
    this.lastAcceptedMetrics = null;
    this.lastEndGateFlush = null;
```

In `onSessionStopped`, flush before building captured systems:

```ts
    this.lastEndGateFlush = this.endCandidateGate.flushUnconfirmed(session.id);
```

Replace `processRoiSample` with:

```ts
  private processRoiSample(sample: RoiSample, frame: OffscreenInputFrame): ScoreClusterUpdate {
    const normalized = this.normalizer.normalize(sample);
    const fingerprint = this.fingerprintGenerator.generate(normalized, sample.image.width / Math.max(1, sample.image.height));
    const qualityScore = this.qualityEvaluator.score(normalized);
    const metrics = measureEndCandidate(normalized);
    const update = this.endCandidateGate.handle({
      sample,
      fingerprint,
      qualityScore,
      imageBlobId: `roi-representative:${sample.id}`,
      nearEnd: frame.meta.nearEnd === true,
      videoEnded: frame.meta.videoEnded === true,
      metrics,
      previousAcceptedMetrics: this.lastAcceptedMetrics
    });

    if (update.exported !== false && update.cluster?.status === "accepted") {
      this.lastAcceptedMetrics = metrics;
    }

    return update;
  }
```

Update call site:

```ts
const clusterUpdate = sample ? this.processRoiSample(sample, frame) : null;
```

Update `storeRepresentativeImage` guard:

```ts
    if (update.exported === false || !sample || !blobId) {
      return;
    }
```

Extend `toIdentityDebug` return:

```ts
    endGate: update.endGate,
    endGateReason: update.endGateReason,
    exported: update.exported,
    pendingEndCandidateCount: update.pendingEndCandidateCount,
```

Extend `summarizeIdentity`:

```ts
    `endGate=${identity.endGate ?? "none"}`,
    `exported=${identity.exported === false ? "false" : "true"}`,
```

- [ ] **Step 4: Run integration tests**

Run:

```bash
npm test -- --test-name-pattern "debug frame sink excludes unconfirmed final candidates|debug frame sink emits staff-cropped unique score images"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/offscreen/debug-frame-sink.ts tests/debug-frame-sink.test.ts
git commit -m "feat: apply end gate to ROI identity"
```

---

### Task 7: Final Regression and Documentation Check

**Files:**
- Modify: `README.md`
- Verify: all changed source and tests

**Interfaces:**
- Produces: README note documenting end overlay behavior and debug-only unresolved candidates.

- [ ] **Step 1: Add README detector ceiling note**

In `README.md`, under `## Current Detector Ceilings`, add:

```md
- Near the end of a video, a new `different` ROI candidate must be confirmed by two score-like samples before it is exported. Unconfirmed final candidates stay in debug metadata and are excluded from PDF/PNG output.
```

- [ ] **Step 2: Run full verification**

Run:

```bash
npm run verify
```

Expected:

```text
> score-frame-collector@0.1.0 verify
> npm run typecheck && npm test && npm run build
...
# fail 0
✓ built
```

- [ ] **Step 3: Review changed files**

Run:

```bash
git diff --stat
git diff -- src/shared/score-identity-config.ts src/shared/roi-types.ts src/shared/cluster-types.ts src/shared/types.ts src/offscreen/identity/staff-content-extractor.ts src/offscreen/identity/end-candidate-metrics.ts src/offscreen/identity/end-candidate-gate.ts src/offscreen/identity/score-clusterer.ts src/offscreen/frame-input-collector.ts src/offscreen/debug-frame-sink.ts tests/end-candidate-gate.test.ts tests/debug-frame-sink.test.ts tests/roi-identity.test.ts README.md
```

Expected: changes are limited to end-gate config, metrics, gate, cluster preview, timing metadata, debug integration, tests, and README. No AI/API default path is introduced.

- [ ] **Step 4: Commit**

```bash
git add README.md src/shared/score-identity-config.ts src/shared/roi-types.ts src/shared/cluster-types.ts src/shared/types.ts src/offscreen/identity/staff-content-extractor.ts src/offscreen/identity/end-candidate-metrics.ts src/offscreen/identity/end-candidate-gate.ts src/offscreen/identity/score-clusterer.ts src/offscreen/frame-input-collector.ts src/offscreen/debug-frame-sink.ts tests/end-candidate-gate.test.ts tests/debug-frame-sink.test.ts tests/roi-identity.test.ts
git commit -m "test: verify end overlay gate"
```

---

## Self-Review

### Spec Coverage

- End-screen/profile overlay export prevention: Task 4, Task 6.
- Real final score preserved after two confirmations: Task 4.
- Single ambiguous end-region candidate not exported: Task 4, Task 6.
- Debug-only unresolved candidate: Task 1, Task 4, Task 6.
- No default AI/API: Global Constraints and Task 7 diff review.
- Existing clustering preserved: Task 3 and Task 7.
- Verification: Task 7.

### Placeholder Scan

No placeholders remain. Every task names exact files, commands, expected outputs, interfaces, and concrete code snippets.

### Type Consistency

The plan consistently uses:

- `EndGateStatus`
- `EndCandidateMetrics`
- `measureEndCandidate`
- `isScoreLikeEndCandidate`
- `EndCandidateGate`
- `EndCandidateGateInput`
- `ScoreClusterer.previewFingerprint`
- `ScoreClusterer.confirmDifferent`
- `ScoreClusterUpdate.endGate`
- `ScoreClusterUpdate.exported`

