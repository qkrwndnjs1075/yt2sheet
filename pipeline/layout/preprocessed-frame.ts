import type { Rect } from "../layout-types";

export type PreprocessedFrame = {
  frameId: string;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  sourceRect: Rect;
  analysisScale: number;
  binary: Uint8Array;
  rowDarkCounts: number[];
  rowLineScores: number[];
  rowEdgeScores: number[];
  rowBrightCounts: number[];
  threshold: number;
};

export function toOriginalRect(frame: PreprocessedFrame, rect: Rect): Rect {
  return {
    x: frame.sourceRect.x + rect.x / frame.analysisScale,
    y: frame.sourceRect.y + rect.y / frame.analysisScale,
    width: rect.width / frame.analysisScale,
    height: rect.height / frame.analysisScale
  };
}

export function toAnalysisRect(frame: PreprocessedFrame, rect: Rect): Rect {
  return {
    x: (rect.x - frame.sourceRect.x) * frame.analysisScale,
    y: (rect.y - frame.sourceRect.y) * frame.analysisScale,
    width: rect.width * frame.analysisScale,
    height: rect.height * frame.analysisScale
  };
}
