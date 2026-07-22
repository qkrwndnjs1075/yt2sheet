import { intersectionOverUnion, lerpRect, rectCenterDistance } from "../../shared/geometry";
import type { DetectedSystem, TrackedSystemBox } from "../../shared/layout-types";

const STALE_FRAME_DISTANCE = 6;
const SMOOTHING = 0.35;

export class TemporalStabilizer {
  private tracks: TrackedSystemBox[] = [];
  private nextTrackId = 1;

  update(frameIndex: number, systems: DetectedSystem[]): DetectedSystem[] {
    const matchedTrackIds = new Set<string>();
    const stabilized = systems.map((system) => {
      const track = this.findBestTrack(system);

      if (!track) {
        const created = this.createTrack(frameIndex, system);
        matchedTrackIds.add(created.trackId);
        return this.applyTrack(system, created);
      }

      track.rect = lerpRect(track.rect, system.rect, SMOOTHING);
      track.lastSeenFrameIndex = frameIndex;
      track.seenCount += 1;
      track.stabilityScore = Math.min(1, track.seenCount / 3);
      matchedTrackIds.add(track.trackId);
      return this.applyTrack(system, track);
    });

    this.tracks = this.tracks.filter((track) => matchedTrackIds.has(track.trackId) || frameIndex - track.lastSeenFrameIndex <= STALE_FRAME_DISTANCE);
    return stabilized;
  }

  reset(): void {
    this.tracks = [];
    this.nextTrackId = 1;
  }

  getDebugInfo(): { trackedBoxes: TrackedSystemBox[]; stableBoxCount: number } {
    return {
      trackedBoxes: this.tracks.map((track) => ({ ...track, rect: { ...track.rect } })),
      stableBoxCount: this.tracks.filter((track) => track.stabilityScore >= 0.66).length
    };
  }

  private findBestTrack(system: DetectedSystem): TrackedSystemBox | null {
    let best: { track: TrackedSystemBox; score: number } | null = null;

    for (const track of this.tracks) {
      const iou = intersectionOverUnion(system.rect, track.rect);
      const distanceScore = 1 / (1 + rectCenterDistance(system.rect, track.rect) / Math.max(1, system.rect.height));
      const score = Math.max(iou, distanceScore * 0.75);

      if (score > 0.45 && (!best || score > best.score)) {
        best = { track, score };
      }
    }

    return best?.track ?? null;
  }

  private createTrack(frameIndex: number, system: DetectedSystem): TrackedSystemBox {
    const track: TrackedSystemBox = {
      trackId: `track_${this.nextTrackId}`,
      rect: { ...system.rect },
      firstSeenFrameIndex: frameIndex,
      lastSeenFrameIndex: frameIndex,
      seenCount: 1,
      stabilityScore: 1 / 3
    };
    this.nextTrackId += 1;
    this.tracks.push(track);
    return track;
  }

  private applyTrack(system: DetectedSystem, track: TrackedSystemBox): DetectedSystem {
    return {
      ...system,
      id: track.trackId,
      rect: { ...track.rect },
      confidence: Math.min(1, system.confidence * (0.75 + 0.25 * track.stabilityScore))
    };
  }
}
