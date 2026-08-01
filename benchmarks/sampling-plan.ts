const MAX_CANDIDATES = 3_600;
const MIN_INTERVAL_MS = 500;
const EVENT_THRESHOLD = 12;
const NMS_WINDOW_MS = 500;
const EVENT_OFFSETS_MS = [-250, 0, 250] as const;

export type ScoreEvent = {
  readonly timestampMs: number;
  readonly score: number;
};

export type ScoreEventTrace = {
  readonly schemaVersion: "score-events/1";
  readonly assetId: string;
  readonly events: readonly ScoreEvent[];
};

export type ControlSamplingPlan = {
  readonly intervalMs: number;
  readonly productionFps: number;
  readonly budget: number;
  readonly timestampsMs: readonly number[];
};

function assertDuration(durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new RangeError("Benchmark duration must be a positive finite number.");
  }
}

function timestampsAtStep(durationMs: number, stepMs: number, limit: number): number[] {
  const timestamps: number[] = [];
  for (let index = 0; index < limit; index += 1) {
    const timestampMs = Math.round(index * stepMs);
    if (timestampMs >= durationMs) break;
    if (timestamps.at(-1) !== timestampMs) timestamps.push(timestampMs);
  }
  return timestamps;
}

export function buildControlSamplingPlan(durationMs: number): ControlSamplingPlan {
  assertDuration(durationMs);
  const intervalMs = Math.max(MIN_INTERVAL_MS, durationMs / MAX_CANDIDATES);
  const timestampsMs = timestampsAtStep(durationMs, intervalMs, MAX_CANDIDATES);
  return {
    intervalMs,
    productionFps: 1_000 / intervalMs,
    budget: timestampsMs.length,
    timestampsMs
  };
}

function validateTrace(durationMs: number, trace: ScoreEventTrace): void {
  for (const event of trace.events) {
    if (!Number.isInteger(event.timestampMs) || event.timestampMs < 0 || event.timestampMs >= durationMs) {
      throw new RangeError("Event timestamp must be an integer inside the asset duration.");
    }
    if (!Number.isFinite(event.score) || event.score < 0 || event.score > 100) {
      throw new RangeError("Event score must be finite and between zero and one hundred.");
    }
  }
}

function retainRankedEvents(events: readonly ScoreEvent[]): ScoreEvent[] {
  const ranked = events
    .filter((event) => event.score >= EVENT_THRESHOLD)
    .sort((left, right) => right.score - left.score || left.timestampMs - right.timestampMs);
  const retained: ScoreEvent[] = [];
  for (const event of ranked) {
    if (retained.every((kept) => Math.abs(kept.timestampMs - event.timestampMs) >= NMS_WINDOW_MS)) {
      retained.push(event);
    }
  }
  return retained;
}

export function buildTreatmentTimestamps(durationMs: number, trace: ScoreEventTrace): readonly number[] {
  const control = buildControlSamplingPlan(durationMs);
  validateTrace(durationMs, trace);
  const floorStepMs = Math.round(2 * control.intervalMs);
  const selected = new Set(timestampsAtStep(durationMs, floorStepMs, control.budget));
  for (const event of retainRankedEvents(trace.events)) {
    for (const offsetMs of EVENT_OFFSETS_MS) {
      if (selected.size >= control.budget) break;
      const timestampMs = Math.round(Math.max(0, Math.min(durationMs - 1, event.timestampMs + offsetMs)));
      selected.add(timestampMs);
    }
    if (selected.size >= control.budget) break;
  }
  return [...selected].sort((left, right) => left - right);
}
