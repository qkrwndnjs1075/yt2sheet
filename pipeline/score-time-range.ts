export type ScoreTimeRange = {
  readonly startTimeSec?: number;
  readonly endTimeSec?: number;
};

export type ResolvedScoreTimeRange =
  | {
    readonly kind: "full";
    readonly startTimeSec: number;
    readonly endTimeSec: number;
    readonly sampleDurationSec: number;
    readonly hasStartBound: false;
    readonly hasEndBound: false;
  }
  | {
    readonly kind: "explicit";
    readonly startTimeSec: number;
    readonly endTimeSec: number;
    readonly sampleDurationSec: number;
    readonly hasStartBound: boolean;
    readonly hasEndBound: boolean;
  };

export type ScoreTimeRangeResolutionReason =
  | "INVALID_START"
  | "INVALID_END"
  | "START_OUT_OF_BOUNDS"
  | "END_NOT_AFTER_START"
  | "END_OUT_OF_BOUNDS";

export type ScoreTimeRangeResolution =
  | ResolvedScoreTimeRange
  | { readonly kind: "invalid"; readonly reason: ScoreTimeRangeResolutionReason };

export function formatResolvedScoreTimeRange(timeRange: ResolvedScoreTimeRange): string {
  return `[${formatTimecode(timeRange.startTimeSec)}, ${formatTimecode(timeRange.endTimeSec)})`;
}

export function resolveScoreTimeRange(
  timeRange: ScoreTimeRange | undefined,
  sourceDurationSec: number
): ScoreTimeRangeResolution {
  if (!Number.isFinite(sourceDurationSec) || sourceDurationSec <= 0) {
    throw new RangeError("sourceDurationSec must be finite and positive");
  }

  if (timeRange === undefined) {
    return {
      kind: "full",
      startTimeSec: 0,
      endTimeSec: sourceDurationSec,
      sampleDurationSec: sourceDurationSec,
      hasStartBound: false,
      hasEndBound: false
    };
  }

  const hasStartBound = timeRange.startTimeSec !== undefined;
  const hasEndBound = timeRange.endTimeSec !== undefined;
  const startTimeSec = timeRange.startTimeSec ?? 0;
  const endTimeSec = timeRange.endTimeSec ?? sourceDurationSec;

  if (!Number.isFinite(startTimeSec) || startTimeSec < 0) {
    return { kind: "invalid", reason: "INVALID_START" };
  }
  if (!Number.isFinite(endTimeSec) || endTimeSec < 0) {
    return { kind: "invalid", reason: "INVALID_END" };
  }
  if (startTimeSec >= sourceDurationSec) {
    return { kind: "invalid", reason: "START_OUT_OF_BOUNDS" };
  }
  if (endTimeSec <= startTimeSec) {
    return { kind: "invalid", reason: "END_NOT_AFTER_START" };
  }
  if (endTimeSec > sourceDurationSec) {
    return { kind: "invalid", reason: "END_OUT_OF_BOUNDS" };
  }

  return {
    kind: "explicit",
    startTimeSec,
    endTimeSec,
    sampleDurationSec: endTimeSec - startTimeSec,
    hasStartBound,
    hasEndBound
  };
}

function formatTimecode(totalSeconds: number): string {
  const roundedSeconds = Math.round(totalSeconds * 1_000_000_000) / 1_000_000_000;
  const wholeSeconds = Math.floor(roundedSeconds);
  const totalMinutes = Math.floor(wholeSeconds / 60);
  const seconds = wholeSeconds % 60;
  const fraction = roundedSeconds.toFixed(9).split(".")[1]?.replace(/0+$/, "") ?? "";
  const secondsText = `${String(seconds).padStart(2, "0")}${fraction ? `.${fraction}` : ""}`;

  if (totalMinutes >= 60) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}:${String(minutes).padStart(2, "0")}:${secondsText}`;
  }

  return `${String(totalMinutes).padStart(2, "0")}:${secondsText}`;
}
