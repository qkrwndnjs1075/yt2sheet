import type { FrameLayout } from "../../shared/layout-types";

export function summarizeLayout(layout: FrameLayout): string {
  return [
    `scoreDetected=${layout.scoreDetected}`,
    `scoreRegions=${layout.scoreRegions.length}`,
    `staffCandidates=${layout.debug?.staffCandidates.length ?? 0}`,
    `systems=${layout.systems.length}`,
    `confidence=${layout.confidence.toFixed(2)}`,
    `processing=${layout.debug?.processingTimeMs.toFixed(1) ?? "-"}ms`
  ].join(" | ");
}
