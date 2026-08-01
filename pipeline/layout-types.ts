export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

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
