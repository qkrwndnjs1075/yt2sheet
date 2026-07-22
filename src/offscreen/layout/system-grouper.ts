import { clamp, expandRect, scoreFromDistance, unionRects } from "../../shared/geometry";
import type { DetectedSystem, LayoutScale, StaffCandidate } from "../../shared/layout-types";

export class SystemGrouper {
  group(candidates: StaffCandidate[], scale: LayoutScale): DetectedSystem[] {
    const sorted = [...candidates].sort((a, b) => a.rect.y - b.rect.y);
    const systems: DetectedSystem[] = [];
    let index = 0;

    while (index < sorted.length) {
      const current = sorted[index];
      const next = sorted[index + 1];

      if (next && this.canPair(current, next, scale)) {
        systems.push(this.buildSystem([current, next], systems.length + 1, scale));
        index += 2;
        continue;
      }

      systems.push(this.buildSystem([current], systems.length + 1, scale));
      index += 1;
    }

    return systems;
  }

  private canPair(a: StaffCandidate, b: StaffCandidate, scale: LayoutScale): boolean {
    if (a.kind === "tab_staff" && b.kind === "tab_staff") {
      return false;
    }

    const gap = b.rect.y - (a.rect.y + a.rect.height);
    const lineGap = scale.estimatedStaffLineGap ?? Math.max(a.metrics.estimatedLineGap, b.metrics.estimatedLineGap);
    const maxGap = lineGap * 4.5;
    const xAlignmentScore = scoreFromDistance(Math.abs(a.rect.x - b.rect.x), Math.max(12, lineGap * 2.5));
    const widthSimilarityScore = scoreFromDistance(Math.abs(a.rect.width - b.rect.width), Math.max(12, Math.max(a.rect.width, b.rect.width) * 0.12));

    return gap >= 0 && gap <= maxGap && xAlignmentScore >= 0.45 && widthSimilarityScore >= 0.55;
  }

  private buildSystem(staffs: StaffCandidate[], index: number, scale: LayoutScale): DetectedSystem {
    const lineGap = scale.estimatedStaffLineGap ?? staffs[0]?.metrics.estimatedLineGap ?? 8;
    const rect = expandRect(unionRects(staffs.map((staff) => staff.rect)), lineGap * 1.2);
    const xAlignmentScore = staffs.length <= 1 ? 1 : scoreFromDistance(Math.max(...staffs.map((staff) => staff.rect.x)) - Math.min(...staffs.map((staff) => staff.rect.x)), lineGap * 3);
    const widths = staffs.map((staff) => staff.rect.width);
    const widthSimilarityScore = staffs.length <= 1 ? 1 : scoreFromDistance(Math.max(...widths) - Math.min(...widths), Math.max(...widths) * 0.15);
    const verticalGapScore = staffs.length <= 1 ? 1 : this.verticalGapScore(staffs, lineGap);
    const confidence = clamp(
      average(staffs.map((staff) => staff.confidence)) * 0.65 + xAlignmentScore * 0.12 + widthSimilarityScore * 0.12 + verticalGapScore * 0.11,
      0,
      1
    );

    return {
      id: `sys_${index}`,
      rect,
      kind: this.kindFor(staffs),
      staffCandidates: staffs,
      confidence,
      source: "staff_grouping",
      groupingReason: {
        staffCount: staffs.length,
        xAlignmentScore,
        widthSimilarityScore,
        verticalGapScore
      }
    };
  }

  private verticalGapScore(staffs: StaffCandidate[], lineGap: number): number {
    const sorted = [...staffs].sort((a, b) => a.rect.y - b.rect.y);
    const gaps = sorted.slice(1).map((staff, index) => staff.rect.y - (sorted[index].rect.y + sorted[index].rect.height));
    return average(gaps.map((gap) => scoreFromDistance(Math.abs(gap - lineGap * 3.6), lineGap * 4.5)));
  }

  private kindFor(staffs: StaffCandidate[]): DetectedSystem["kind"] {
    if (staffs.length === 1) {
      return staffs[0].kind === "tab_staff" ? "tab" : staffs[0].kind === "standard_staff" ? "single_staff" : "unknown";
    }

    const hasTab = staffs.some((staff) => staff.kind === "tab_staff");
    const hasStandard = staffs.some((staff) => staff.kind === "standard_staff");

    if (hasTab && hasStandard) {
      return "tab_plus_staff";
    }

    if (hasStandard && staffs.length === 2) {
      return "grand_staff";
    }

    return "unknown";
  }
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
