import { median } from "../../shared/geometry";
import type { LayoutScale, StaffCandidate } from "../../shared/layout-types";

export class ScaleEstimator {
  estimate(candidates: StaffCandidate[]): LayoutScale {
    const gaps = candidates
      .map((candidate) => candidate.metrics.estimatedLineGap)
      .filter((gap) => Number.isFinite(gap) && gap > 0);
    const estimatedStaffLineGap = median(gaps);

    return {
      estimatedStaffLineGap,
      estimatedStaffHeight: estimatedStaffLineGap ? estimatedStaffLineGap * 4 : undefined,
      estimatedSystemGap: estimatedStaffLineGap ? estimatedStaffLineGap * 7 : undefined,
      confidence: estimatedStaffLineGap ? Math.min(1, gaps.length / 4) : 0
    };
  }
}
