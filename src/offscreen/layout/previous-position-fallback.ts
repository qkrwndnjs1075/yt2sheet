import type { DetectedSystem } from "../../shared/layout-types";

const PREVIOUS_POSITION_FALLBACK_TTL_MS = 2000;

type LastStableSystem = {
  systems: DetectedSystem[];
  timestampSec: number;
};

export class PreviousPositionFallback {
  private last: LastStableSystem | null = null;

  update(systems: DetectedSystem[], timestampSec: number): void {
    if (systems.length > 0) {
      this.last = {
        systems: systems.map((system) => ({ ...system, rect: { ...system.rect }, staffCandidates: [...system.staffCandidates] })),
        timestampSec
      };
    }
  }

  tryGet(timestampSec: number): DetectedSystem[] {
    if (!this.last || (timestampSec - this.last.timestampSec) * 1000 > PREVIOUS_POSITION_FALLBACK_TTL_MS) {
      return [];
    }

    return this.last.systems.map((system, index) => ({
      ...system,
      id: `previous_position_${index + 1}`,
      kind: "unknown",
      source: "previous_position_fallback",
      confidence: Math.min(0.55, system.confidence * 0.75),
      staffCandidates: []
    }));
  }

  reset(): void {
    this.last = null;
  }
}
