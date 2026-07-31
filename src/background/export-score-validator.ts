// allow: SIZE_OK - inherited validation and replacement-selection seam; accepted debt to preserve occurrence identity.
import type { DebugUniqueScore, ExportValidationDetail, ExportValidationSummary } from "../shared/messages";
import { orderScoreOccurrences } from "../shared/score-occurrences";
import { BrowserExportScoreImageCleaner, type ExportScoreImageCleaner } from "./export-score-image-cleaner";
import { hasLargeFilledOverlay } from "./score-overlay-detection";

export type ScoreInspectionStatus = "valid" | "contaminated" | "uncertain";

export type ScoreInspectionResult = {
  status: ScoreInspectionStatus;
  confidence: number;
  reason: string;
  source: "local";
};

export type ScoreInspector = {
  inspect(score: DebugUniqueScore): Promise<ScoreInspectionResult>;
};

export type ExportValidationReport = {
  scores: DebugUniqueScore[];
  decisions: ExportValidationDetail[];
  summary: ExportValidationSummary;
};

type ValidateExportScoresOptions = {
  occurrenceOrder?: string[];
  scoreOrder?: string[];
  candidates?: DebugUniqueScore[];
  localInspector?: ScoreInspector;
  imageCleaner?: ExportScoreImageCleaner;
};

type ScoreGeometryBaseline = {
  readonly medianWidth: number;
};

export async function validateExportScores(
  scores: DebugUniqueScore[],
  options: ValidateExportScoresOptions = {}
): Promise<ExportValidationReport> {
  const localInspector = options.localInspector ?? new LocalExportScoreInspector();
  const imageCleaner = options.imageCleaner ?? new BrowserExportScoreImageCleaner();
  const orderedScores = orderSelectedScores(scores, {
    occurrenceOrder: options.occurrenceOrder,
    scoreOrder: options.scoreOrder
  });
  const rawCandidatesByClusterId = groupCandidatesByClusterId([...(options.candidates ?? []), ...scores]);
  const selectedScores: DebugUniqueScore[] = [];
  for (const score of orderedScores) {
    selectedScores.push(await imageCleaner.clean(score, rawCandidatesByClusterId.get(score.clusterId) ?? []));
  }
  const geometryBaseline = buildScoreGeometryBaseline(selectedScores);
  const candidatesByClusterId = groupCandidatesByClusterId([...(options.candidates ?? []), ...scores]);
  const validatedScores: DebugUniqueScore[] = [];
  const decisions: ExportValidationDetail[] = [];

  for (const score of selectedScores) {
    const inspection = await inspectScore(score, localInspector, geometryBaseline);

    if (isExportable(inspection)) {
      validatedScores.push(score);
      decisions.push({
        ...validationDecisionIdentity(score),
        action: "kept",
        reason: inspection.reason,
        validator: inspection.source
      });
      continue;
    }

    const replacement = await findCleanReplacement(
      score,
      candidatesByClusterId.get(score.clusterId) ?? [],
      imageCleaner,
      localInspector,
      geometryBaseline
    );

    if (replacement) {
      validatedScores.push(scoreForReplacementOccurrence(score, replacement));
      decisions.push({
        ...validationDecisionIdentity(score),
        action: "replaced",
        reason: inspection.reason,
        replacementScoreId: replacement.id,
        validator: inspection.source
      });
      continue;
    }

    decisions.push({
      ...validationDecisionIdentity(score),
      action: "excluded",
      reason: inspection.reason,
      validator: inspection.source
    });
  }

  const summary: ExportValidationSummary = {
    keptCount: decisions.filter((decision) => decision.action === "kept").length,
    replacedCount: decisions.filter((decision) => decision.action === "replaced").length,
    excludedCount: decisions.filter((decision) => decision.action === "excluded").length,
    notes: decisions
      .filter((decision) => decision.action !== "kept")
      .map((decision) => `${decision.clusterId}: ${decision.action} (${decision.reason})`)
  };

  return { scores: validatedScores, decisions, summary };
}

async function inspectScore(
  score: DebugUniqueScore,
  localInspector: ScoreInspector,
  geometryBaseline: ScoreGeometryBaseline | null
): Promise<ScoreInspectionResult> {
  const geometryInspection = inspectScoreGeometry(score, geometryBaseline);
  return geometryInspection ?? localInspector.inspect(score);
}

async function findCleanReplacement(
  original: DebugUniqueScore,
  candidates: DebugUniqueScore[],
  imageCleaner: ExportScoreImageCleaner,
  localInspector: ScoreInspector,
  geometryBaseline: ScoreGeometryBaseline | null
): Promise<DebugUniqueScore | null> {
  const ordered = candidates
    .filter((candidate) => canReplaceScoreOccurrence(original, candidate))
    .sort((a, b) => compareReplacementCandidate(original, a, b));

  for (const candidate of ordered) {
    const cleanedCandidate = await imageCleaner.clean(candidate, candidates);
    const inspection = await inspectScore(cleanedCandidate, localInspector, geometryBaseline);
    if (isExportable(inspection)) {
      return cleanedCandidate;
    }
  }

  return null;
}

function buildScoreGeometryBaseline(scores: readonly DebugUniqueScore[]): ScoreGeometryBaseline | null {
  if (scores.length < 3) {
    return null;
  }

  return {
    medianWidth: median(scores.map((score) => score.image.width))
  };
}

function inspectScoreGeometry(score: DebugUniqueScore, baseline: ScoreGeometryBaseline | null): ScoreInspectionResult | null {
  const { width, height } = score.image;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { status: "contaminated", confidence: 1, reason: "invalid image geometry", source: "local" };
  }

  if (!baseline) {
    return null;
  }

  const widthRatio = width / Math.max(1, baseline.medianWidth);
  if (widthRatio < 0.75) {
    return {
      status: "contaminated",
      confidence: 0.98,
      reason: `incomplete image geometry (width ${width} vs session median ${baseline.medianWidth})`,
      source: "local"
    };
  }

  return null;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? 0;
}

function canReplaceScoreOccurrence(original: DebugUniqueScore, candidate: DebugUniqueScore): boolean {
  if (candidate.id === original.id || !candidate.image.dataUrl || candidate.image.dataUrl === original.image.dataUrl) {
    return false;
  }
  if (original.occurrenceId === undefined || candidate.occurrenceId === undefined) {
    return true;
  }
  return candidate.occurrenceId === original.occurrenceId;
}

function compareReplacementCandidate(original: DebugUniqueScore, left: DebugUniqueScore, right: DebugUniqueScore): number {
  return (
    occurrenceMatchRank(original, left) - occurrenceMatchRank(original, right) ||
    right.qualityScore - left.qualityScore ||
    left.source.firstSeenSec - right.source.firstSeenSec
  );
}

function occurrenceMatchRank(original: DebugUniqueScore, candidate: DebugUniqueScore): number {
  if (original.occurrenceId === undefined) {
    return 0;
  }
  return candidate.occurrenceId === original.occurrenceId ? 0 : 1;
}

function scoreForReplacementOccurrence(original: DebugUniqueScore, replacement: DebugUniqueScore): DebugUniqueScore {
  return {
    ...replacement,
    ...(original.occurrenceId !== undefined ? { occurrenceId: original.occurrenceId } : {}),
    ...(original.occurrenceOrder !== undefined ? { occurrenceOrder: original.occurrenceOrder } : {}),
    ...(original.repeatIndex !== undefined ? { repeatIndex: original.repeatIndex } : {}),
    ...(original.repeatCount !== undefined ? { repeatCount: original.repeatCount } : {}),
    ...(original.previousOccurrenceId !== undefined ? { previousOccurrenceId: original.previousOccurrenceId } : {}),
    ...(original.nextOccurrenceId !== undefined ? { nextOccurrenceId: original.nextOccurrenceId } : {})
  };
}

function isExportable(result: ScoreInspectionResult): boolean {
  return result.status === "valid";
}

type ScoreSelectionOptions = {
  readonly occurrenceOrder?: readonly string[];
  readonly scoreOrder?: readonly string[];
};

function orderSelectedScores(scores: DebugUniqueScore[], options: ScoreSelectionOptions): DebugUniqueScore[] {
  return orderScoreOccurrences(scores.filter((score) => Boolean(score.image.dataUrl)), options);
}

function groupCandidatesByClusterId(scores: DebugUniqueScore[]): Map<string, DebugUniqueScore[]> {
  const map = new Map<string, DebugUniqueScore[]>();
  for (const score of scores) {
    if (!score.image.dataUrl) {
      continue;
    }
    map.set(score.clusterId, [...(map.get(score.clusterId) ?? []), score]);
  }
  return map;
}

function validationDecisionIdentity(score: DebugUniqueScore): Pick<ExportValidationDetail, "clusterId" | "scoreId" | "occurrenceId" | "occurrenceOrder"> {
  return {
    clusterId: score.clusterId,
    scoreId: score.id,
    ...(score.occurrenceId !== undefined ? { occurrenceId: score.occurrenceId } : {}),
    ...(score.occurrenceOrder !== undefined ? { occurrenceOrder: score.occurrenceOrder } : {})
  };
}

export class LocalExportScoreInspector implements ScoreInspector {
  async inspect(score: DebugUniqueScore): Promise<ScoreInspectionResult> {
    if (!score.image.dataUrl) {
      return { status: "contaminated", confidence: 1, reason: "missing image data", source: "local" };
    }

    if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas === "undefined") {
      return { status: "contaminated", confidence: 0.75, reason: "local image analysis unavailable", source: "local" };
    }

    try {
      return await inspectImagePixels(score.image.dataUrl);
    } catch {
      return { status: "contaminated", confidence: 0.75, reason: "local image analysis failed", source: "local" };
    }
  }
}

async function inspectImagePixels(dataUrl: string): Promise<ScoreInspectionResult> {
  const blob = dataUrlToBlob(dataUrl);
  const bitmap = await createImageBitmap(blob);
  const width = Math.min(bitmap.width, 160);
  const height = Math.min(bitmap.height, 160);
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    bitmap.close();
    return { status: "contaminated", confidence: 0.75, reason: "local canvas unavailable", source: "local" };
  }

  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const image = context.getImageData(0, 0, width, height);
  const stats = analyzePixels(image.data, width, height);

  if (stats.hasLargeDarkBand || stats.darkRatio > 0.42) {
    return { status: "contaminated", confidence: 0.85, reason: "large dark overlay-like region", source: "local" };
  }

  if (stats.hasLargeFilledOverlay) {
    return { status: "contaminated", confidence: 0.88, reason: "filled overlay remains; recapture required", source: "local" };
  }

  if (!stats.hasStaffLikeRows && stats.darkRatio < 0.01) {
    return { status: "contaminated", confidence: 0.76, reason: "no readable staff content detected", source: "local" };
  }

  return { status: "valid", confidence: 0.72, reason: "score-like image passed local checks", source: "local" };
}

function analyzePixels(data: Uint8ClampedArray, width: number, height: number): {
  darkRatio: number;
  hasLargeDarkBand: boolean;
  hasLargeFilledOverlay: boolean;
  hasStaffLikeRows: boolean;
} {
  let dark = 0;
  const rowDarkRatios: number[] = [];

  for (let y = 0; y < height; y += 1) {
    let rowDark = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const luminance = 0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2];
      if (luminance < 90) {
        dark += 1;
        rowDark += 1;
      }
    }
    rowDarkRatios.push(rowDark / Math.max(1, width));
  }

  const darkRatio = dark / Math.max(1, width * height);
  const largeBandThreshold = Math.max(6, Math.round(height * 0.08));
  let consecutiveDarkRows = 0;
  let hasLargeDarkBand = false;
  let staffLikeRows = 0;

  for (const rowRatio of rowDarkRatios) {
    if (rowRatio > 0.68) {
      consecutiveDarkRows += 1;
      hasLargeDarkBand ||= consecutiveDarkRows >= largeBandThreshold;
    } else {
      consecutiveDarkRows = 0;
    }

    if (rowRatio > 0.04 && rowRatio < 0.58) {
      staffLikeRows += 1;
    }
  }

  return {
    darkRatio,
    hasLargeDarkBand,
    hasLargeFilledOverlay: hasLargeFilledOverlay({ width, height, data }),
    hasStaffLikeRows: staffLikeRows >= 4
  };
}

function splitDataUrl(dataUrl: string): { mimeType: string; base64: string } {
  const [header, payload] = dataUrl.split(",");
  const mimeType = /^data:([^;]+);base64$/.exec(header ?? "")?.[1] ?? "image/png";
  return { mimeType, base64: payload ?? "" };
}

function dataUrlToBlob(dataUrl: string): Blob {
  const { mimeType, base64 } = splitDataUrl(dataUrl);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}
