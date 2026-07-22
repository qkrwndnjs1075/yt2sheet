import type { DebugCaptureState } from "../shared/debug-state";
import type { DebugScoreOccurrence, DebugUniqueScore } from "../shared/messages";

export type CaptureImageEntries = Record<string, string>;
export const CAPTURE_IMAGE_KEY_PREFIX = "capture-image:";

export function compactCaptureImages(state: DebugCaptureState): {
  state: DebugCaptureState;
  images: CaptureImageEntries;
} {
  const images: CaptureImageEntries = {};

  return {
    state: {
      ...state,
      uniqueScores: state.uniqueScores.map((score) => compactScore(score, images)),
      ...(state.exportOccurrences
        ? { exportOccurrences: state.exportOccurrences.map((score) => compactScore(score, images)) }
        : {}),
      exportCandidates: state.exportCandidates.map((score) => compactScore(score, images))
    },
    images
  };
}

export function hydrateCaptureImages(
  state: DebugCaptureState,
  images: CaptureImageEntries
): DebugCaptureState {
  return {
    ...state,
    uniqueScores: state.uniqueScores.map((score) => hydrateScore(score, images)),
    ...(state.exportOccurrences
      ? { exportOccurrences: state.exportOccurrences.map((score) => hydrateScore(score, images)) }
      : {}),
    exportCandidates: state.exportCandidates.map((score) => hydrateScore(score, images))
  };
}

export function captureImageKeys(state: DebugCaptureState): string[] {
  const keys = new Set<string>();
  const scores = [
    ...state.uniqueScores,
    ...(state.exportOccurrences ?? []),
    ...state.exportCandidates
  ];

  scores.forEach((score) => keys.add(captureImageKey(score)));
  return [...keys];
}

function compactScore<T extends DebugUniqueScore | DebugScoreOccurrence>(
  score: T,
  images: CaptureImageEntries
): T {
  const { dataUrl, ...image } = score.image;
  if (dataUrl) {
    images[captureImageKey(score)] = dataUrl;
  }

  return { ...score, image };
}

function hydrateScore<T extends DebugUniqueScore | DebugScoreOccurrence>(score: T, images: CaptureImageEntries): T {
  const dataUrl = images[captureImageKey(score)];
  return dataUrl ? { ...score, image: { ...score.image, dataUrl } } : score;
}

function captureImageKey(score: DebugUniqueScore | DebugScoreOccurrence): string {
  return `${CAPTURE_IMAGE_KEY_PREFIX}${encodeURIComponent(score.sessionId)}:${encodeURIComponent(score.image.imageBlobId)}`;
}
