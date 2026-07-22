import type { CapturedScoreSystem } from "./capture-types";

export type ScorePage = {
  id: string;
  sessionId: string;
  pageIndex: number;
  systems: CapturedScoreSystem[];
  imageBlobId?: string;
  width: number;
  height: number;
};
