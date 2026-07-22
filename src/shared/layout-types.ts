export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type CandidateJudgeLabel =
  | "score_system"
  | "score_region"
  | "piano_keyboard"
  | "hands"
  | "subtitle_or_ui"
  | "background"
  | "unknown";

export type ScoreRegion = {
  id: string;
  rect: Rect;
  confidence: number;
  reason: {
    horizontalLineDensity: number;
    darkPixelDensity: number;
    aspectRatioScore: number;
    repeatedPatternScore: number;
  };
};

export type ScoreRegionProposal = {
  id: string;
  rect: Rect;
  source: "horizontal_line" | "bright_panel" | "edge_density" | "temporal_stable" | "fallback";
  ruleScores: {
    horizontalLineScore: number;
    brightPanelScore: number;
    edgeDensityScore: number;
    aspectRatioScore: number;
    contrastScore: number;
    finalRuleScore: number;
  };
  ai?: {
    label: CandidateJudgeLabel;
    isScoreCandidate: boolean;
    confidence: number;
    reason: string;
  };
  finalScores: {
    ruleScore: number;
    aiScore: number;
    temporalStabilityScore: number;
    finalScore: number;
  };
  scores: {
    horizontalLineScore: number;
    brightPanelScore: number;
    edgeDensityScore: number;
    aspectRatioScore: number;
    contrastScore: number;
    temporalStabilityScore: number;
    finalScore: number;
  };
  status: "proposal" | "weak" | "promoted" | "final" | "rejected";
  reason?: string;
  rejectReason?: string;
};

export type StaffCandidate = {
  id: string;
  rect: Rect;
  lineCount: 5 | 6 | "unknown";
  kind: "standard_staff" | "tab_staff" | "unknown";
  metrics: {
    estimatedLineGap: number;
    horizontalLineStrength: number;
    lineRegularity: number;
    widthConsistency: number;
  };
  confidence: number;
};

export type DetectedSystem = {
  id: string;
  rect: Rect;
  kind: "single_staff" | "grand_staff" | "tab" | "tab_plus_staff" | "chord_sheet" | "handwritten" | "unknown";
  staffCandidates: StaffCandidate[];
  confidence: number;
  source: "staff_grouping" | "ai_score_system" | "ai_score_region" | "temporal_fallback" | "previous_position_fallback";
  groupingReason: {
    staffCount: number;
    xAlignmentScore: number;
    widthSimilarityScore: number;
    verticalGapScore: number;
    barlineAlignmentScore?: number;
  };
};

export type LayoutScale = {
  estimatedStaffLineGap?: number;
  estimatedStaffHeight?: number;
  estimatedSystemGap?: number;
  confidence: number;
};

export type TrackedSystemBox = {
  trackId: string;
  rect: Rect;
  firstSeenFrameIndex: number;
  lastSeenFrameIndex: number;
  seenCount: number;
  stabilityScore: number;
};

export type TrackedRegionProposal = {
  trackId: string;
  rect: Rect;
  sourceSet: ScoreRegionProposal["source"][];
  firstSeenFrameIndex: number;
  lastSeenFrameIndex: number;
  seenCount: number;
  lastTimestampSec: number;
  stabilityScore: number;
  averageScore: number;
  status: "tracking" | "stable" | "lost";
};

export type AiJudgeDebugInfo = {
  enabled: boolean;
  called: boolean;
  skippedReason?: string;
  contactSheetCandidateIds: string[];
  latencyMs?: number;
  results?: {
    candidateId: string;
    label: CandidateJudgeLabel;
    confidence: number;
    reason: string;
  }[];
  cacheHits: string[];
  cacheMisses: string[];
  error?: string;
};

export type LayoutDebugInfo = {
  videoRoiRect: Rect;
  resizedFrameSize: {
    width: number;
    height: number;
  };
  preprocessing: {
    grayscale: boolean;
    grayscaleGenerated?: boolean;
    thresholdGenerated?: boolean;
    edgeMapGenerated?: boolean;
    thresholdMethod: "simple" | "adaptive" | "otsu" | "none";
    analysisScale: number;
  };
  regionProposals: ScoreRegionProposal[];
  weakCandidates: ScoreRegionProposal[];
  promotedRegions: ScoreRegionProposal[];
  promotedCandidates?: ScoreRegionProposal[];
  scoreRegionCandidates: ScoreRegion[];
  staffCandidates: StaffCandidate[];
  rejectedCandidates: {
    rect: Rect;
    reason: string;
  }[];
  temporal: {
    trackedBoxes: TrackedSystemBox[];
    trackedRegions?: TrackedRegionProposal[];
    stableBoxCount: number;
    stableRegionCount?: number;
  };
  systems?: DetectedSystem[];
  finalSystems?: DetectedSystem[];
  aiJudge?: AiJudgeDebugInfo;
  failureReason?: string;
  processingTimeMs: number;
};

export type FrameLayout = {
  frameId: string;
  sessionId: string;
  timestampSec: number;
  scoreDetected: boolean;
  scoreRegions: ScoreRegion[];
  regionProposals: ScoreRegionProposal[];
  weakCandidates: ScoreRegionProposal[];
  promotedCandidates: ScoreRegionProposal[];
  finalSystems: DetectedSystem[];
  systems: DetectedSystem[];
  confidence: number;
  scale: LayoutScale;
  debug?: LayoutDebugInfo;
};

export type FrameLayoutSummary = Omit<FrameLayout, "debug"> & {
  debug?: {
    videoRoiRect: Rect;
    staffCandidates: StaffCandidate[];
    temporal: {
      stableBoxCount: number;
      stableRegionCount?: number;
    };
    aiJudge?: AiJudgeDebugInfo;
    failureReason?: string;
    processingTimeMs: number;
  };
};
