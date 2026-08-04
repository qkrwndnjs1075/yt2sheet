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
  { index: 1, label: "영상 정보 확인", start: 0 },
  { index: 2, label: "영상 다운로드", start: 12 },
  { index: 3, label: "프레임 추출", start: 32 },
  { index: 4, label: "악보 프레임 분석", start: 45 },
  { index: 5, label: "중복 악보 정리", start: 75 },
  { index: 6, label: "PDF 생성", start: 88 }
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
