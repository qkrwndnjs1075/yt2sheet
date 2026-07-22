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
