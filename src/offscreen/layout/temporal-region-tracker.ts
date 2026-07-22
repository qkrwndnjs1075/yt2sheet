import { intersectionOverUnion, lerpRect } from "../../shared/geometry";
import type { ScoreRegionProposal, TrackedRegionProposal } from "../../shared/layout-types";

const PROPOSAL_IOU_MATCH_THRESHOLD = 0.45;
const STABLE_SEEN_COUNT = 3;
const LOST_TTL_FRAMES = 5;
const SMOOTHING = 0.35;

export class TemporalRegionTracker {
  private tracks: TrackedRegionProposal[] = [];
  private nextTrackId = 1;

  update(frameIndex: number, timestampSec: number, proposals: ScoreRegionProposal[]): ScoreRegionProposal[] {
    const matched = new Set<string>();
    const updated = proposals.map((proposal) => {
      const track = this.findTrack(proposal);

      if (!track) {
        const created = this.createTrack(frameIndex, timestampSec, proposal);
        matched.add(created.trackId);
        return this.applyTrack(proposal, created);
      }

      track.rect = lerpRect(track.rect, proposal.rect, SMOOTHING);
      track.lastSeenFrameIndex = frameIndex;
      track.lastTimestampSec = timestampSec;
      track.seenCount += 1;
      track.averageScore = (track.averageScore * (track.seenCount - 1) + proposal.scores.finalScore) / track.seenCount;
      track.stabilityScore = Math.min(1, track.seenCount / STABLE_SEEN_COUNT);
      track.status = track.seenCount >= STABLE_SEEN_COUNT ? "stable" : "tracking";
      if (!track.sourceSet.includes(proposal.source)) {
        track.sourceSet.push(proposal.source);
      }
      matched.add(track.trackId);
      return this.applyTrack(proposal, track);
    });

    this.tracks = this.tracks
      .map((track) => matched.has(track.trackId) ? track : { ...track, status: "lost" as const })
      .filter((track) => frameIndex - track.lastSeenFrameIndex <= LOST_TTL_FRAMES);

    return updated;
  }

  getDebugInfo(): { trackedRegions: TrackedRegionProposal[]; stableRegionCount: number } {
    return {
      trackedRegions: this.tracks.map((track) => ({ ...track, rect: { ...track.rect }, sourceSet: [...track.sourceSet] })),
      stableRegionCount: this.tracks.filter((track) => track.status === "stable").length
    };
  }

  reset(): void {
    this.tracks = [];
    this.nextTrackId = 1;
  }

  private findTrack(proposal: ScoreRegionProposal): TrackedRegionProposal | null {
    let best: { track: TrackedRegionProposal; score: number } | null = null;

    for (const track of this.tracks) {
      const score = intersectionOverUnion(track.rect, proposal.rect);
      if (score >= PROPOSAL_IOU_MATCH_THRESHOLD && (!best || score > best.score)) {
        best = { track, score };
      }
    }

    return best?.track ?? null;
  }

  private createTrack(frameIndex: number, timestampSec: number, proposal: ScoreRegionProposal): TrackedRegionProposal {
    const track: TrackedRegionProposal = {
      trackId: `region_track_${this.nextTrackId}`,
      rect: { ...proposal.rect },
      sourceSet: [proposal.source],
      firstSeenFrameIndex: frameIndex,
      lastSeenFrameIndex: frameIndex,
      seenCount: 1,
      lastTimestampSec: timestampSec,
      stabilityScore: 1 / STABLE_SEEN_COUNT,
      averageScore: proposal.scores.finalScore,
      status: "tracking"
    };
    this.nextTrackId += 1;
    this.tracks.push(track);
    return track;
  }

  private applyTrack(proposal: ScoreRegionProposal, track: TrackedRegionProposal): ScoreRegionProposal {
    const temporalStabilityScore = track.stabilityScore;
    const promoted = proposal.status === "promoted" || track.status === "stable";
    const finalScore = Math.max(proposal.scores.finalScore, track.status === "stable" ? 0.68 : proposal.scores.finalScore);

    return {
      ...proposal,
      id: `${track.trackId}:${proposal.id}`,
      rect: { ...track.rect },
      source: track.status === "stable" ? "temporal_stable" : proposal.source,
      status: promoted ? "promoted" : proposal.status,
      finalScores: {
        ...proposal.finalScores,
        temporalStabilityScore,
        finalScore
      },
      scores: {
        ...proposal.scores,
        temporalStabilityScore,
        finalScore
      }
    };
  }
}
