import { formatYtDlpProgress, type YtDlpBootstrapProgress } from "./yt-dlp-bootstrap";

export type CliProgressOutput = {
  readonly isTTY?: boolean;
  readonly write: (chunk: string) => boolean;
};

type ProgressReporter<TProgress> = {
  readonly onProgress: (progress: TProgress) => void;
  readonly finish: () => void;
};

export type CliProgressReporter = ProgressReporter<number>;

type ProcessingPhase = {
  readonly index: number;
  readonly label: string;
  readonly start: number;
};

const PROCESSING_PHASES: readonly ProcessingPhase[] = [
  { index: 1, label: "info", start: 0 },
  { index: 2, label: "download", start: 12 },
  { index: 3, label: "extraction", start: 32 },
  { index: 4, label: "raster analysis", start: 45 },
  { index: 5, label: "raster review", start: 75 },
  { index: 6, label: "OMR", start: 80 },
  { index: 7, label: "MusicXML validation", start: 85 },
  { index: 8, label: "engraving", start: 90 },
  { index: 9, label: "PDF publication", start: 98 }
];

const TOTAL_PROCESSING_PHASES = PROCESSING_PHASES.length;
const TERMINAL_CLEAR_LINE = "\r\x1b[2K";

export function formatCliProgress(progress: number): string {
  const normalized = normalizeProgress(progress);
  const phase = resolveProcessingPhase(normalized);
  return `[${phase.index}/${TOTAL_PROCESSING_PHASES}] ${phase.label} ${normalized}%`;
}

export function createCliProgressReporter(output: CliProgressOutput): CliProgressReporter {
  const interactive = output.isTTY === true;
  let lastPhaseIndex: number | undefined;
  let lineIsActive = false;

  return {
    onProgress(progress) {
      const normalized = normalizeProgress(progress);
      const phase = resolveProcessingPhase(normalized);
      if (!interactive && lastPhaseIndex === phase.index && normalized !== 100) {
        return;
      }

      const firstUnreportedPhase = (lastPhaseIndex ?? 0) + 1;
      for (let index = firstUnreportedPhase; index < phase.index; index += 1) {
        const intermediate = PROCESSING_PHASES[index - 1];
        if (intermediate === undefined) continue;
        const line = formatCliProgress(intermediate.start);
        output.write(interactive ? `${TERMINAL_CLEAR_LINE}${line}` : `${line}\n`);
      }
      const line = formatCliProgress(normalized);
      output.write(interactive ? `${TERMINAL_CLEAR_LINE}${line}` : `${line}\n`);
      lastPhaseIndex = phase.index;
      lineIsActive = interactive;
    },
    finish() {
      if (!interactive || !lineIsActive) return;
      output.write(`${TERMINAL_CLEAR_LINE}\n`);
      lineIsActive = false;
    }
  };
}

export function createYtDlpProgressReporter(output: CliProgressOutput): ProgressReporter<YtDlpBootstrapProgress> {
  const interactive = output.isTTY === true;
  let lastPhase: YtDlpBootstrapProgress["phase"] | undefined;
  let lineIsActive = false;

  return {
    onProgress(progress) {
      if (!interactive && lastPhase === progress.phase && progress.percent !== 100) {
        return;
      }

      const line = formatYtDlpProgress(progress);
      const isReady = progress.phase === "ready";
      output.write(interactive ? `${TERMINAL_CLEAR_LINE}${line}${isReady ? "\n" : ""}` : `${line}\n`);
      lastPhase = progress.phase;
      lineIsActive = interactive && !isReady;
    },
    finish() {
      if (!interactive || !lineIsActive) return;
      output.write(`${TERMINAL_CLEAR_LINE}\n`);
      lineIsActive = false;
    }
  };
}

function resolveProcessingPhase(progress: number): ProcessingPhase {
  for (let index = PROCESSING_PHASES.length - 1; index >= 0; index -= 1) {
    const phase = PROCESSING_PHASES[index];
    if (phase !== undefined && progress >= phase.start) {
      return phase;
    }
  }
  return PROCESSING_PHASES[0];
}

function normalizeProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.max(0, Math.min(100, Math.round(progress)));
}
