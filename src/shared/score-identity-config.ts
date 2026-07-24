export type ScorePdfPageLayout = {
  readonly pageWidth: number;
  readonly pageHeight: number;
  readonly padding: number;
  readonly gap: number;
};

export type ScorePdfContract = ScorePdfPageLayout & {
  readonly rasterWidth: number;
  readonly rasterHeight: number;
  readonly targetDpi: number;
};

export const STANDALONE_SCORE_PDF = {
  rasterWidth: 1200,
  rasterHeight: 1700,
  pageWidth: 1200,
  pageHeight: 1700,
  padding: 40,
  gap: 16,
  targetDpi: 72
} as const satisfies ScorePdfContract;

export const SCORE_PDF_METADATA = {
  subject: "Score sheets extracted from user-supplied video",
  keywords: ["yt2sheet", "sheet music", "score export"],
  creator: "yt2sheet",
  producer: "yt2sheet 0.1.0"
} as const;

export const SCORE_PDF_METADATA_POLICY = {
  titlePrefix: "yt2sheet score",
  author: "absent",
  sourceUrl: "absent",
  creationDate: "injected-created-at",
  modificationDate: "same-as-creation-date"
} as const;

export const SCORE_IDENTITY_CONFIG = {
  fingerprint: {
    width: 512,
    height: 160
  },

  sampling: {
    sampleIntervalMs: 1000,
    minNewScoreIntervalMs: 1500,
    minStableDurationMs: 1000
  },

  similarity: {
    sameContentPHashDistance: 8,
    maybeContentPHashDistance: 14,

    sameContentDHashDistance: 10,
    maybeContentDHashDistance: 16,

    sameVerticalProjectionSimilarity: 0.9,
    maybeVerticalProjectionSimilarity: 0.84,

    sameHorizontalProjectionSimilarity: 0.9,
    maybeHorizontalProjectionSimilarity: 0.86,

    sameAspectDiff: 0.08,
    maybeAspectDiff: 0.12,

    maybeInkDensityDiff: 0.12
  },

  cluster: {
    recentAcceptedClusterCompareLimit: 10,
    minAcceptSeenCount: 2,
    differentAcceptConfidence: 0.8
  },

  endGate: {
    nearEndWindowMs: 3000,
    endCandidateRequiredConfirmations: 2,
    maxEndCandidateCropAreaDiff: 0.4,
    maxEndCandidateInkDensityDiff: 0.18,
    maxOverlayDominantRegionRatio: 0.35
  },

  page: {
    pageWidth: 1200,
    pageHeight: 1700,
    padding: 40,
    gap: 16
  },

  debug: {
    enabled: true,
    logSimilarityMetrics: true,
    saveDebugImages: false,
    showPreview: true
  }
} as const;
