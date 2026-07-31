import { clamp } from "../../shared/geometry";
import type { DetectedSystem, FrameLayout, ScoreRegionProposal } from "../../shared/layout-types";
import type { OffscreenInputFrame } from "../frame-sink";
import { ImagePreprocessor } from "./image-preprocessor";
import { PreviousPositionFallback } from "./previous-position-fallback";
import { CandidateResolver } from "./resolver/candidate-resolver";
import { ScaleEstimator } from "./scale-estimator";
import { isWeakProposal, ScoreRegionProposalGenerator } from "./score-region-proposal-generator";
import { StaffCandidateDetector } from "./staff-candidate-detector";
import { SystemGrouper } from "./system-grouper";
import { TemporalRegionTracker } from "./temporal-region-tracker";
import { TemporalStabilizer } from "./temporal-stabilizer";
import { extractVideoRoi } from "./video-roi-extractor";

export class DynamicScoreLayoutDetector {
  private readonly preprocessor = new ImagePreprocessor();
  private readonly proposalGenerator = new ScoreRegionProposalGenerator();
  private readonly staffDetector = new StaffCandidateDetector();
  private readonly scaleEstimator = new ScaleEstimator();
  private readonly systemGrouper = new SystemGrouper();
  private readonly temporalStabilizer = new TemporalStabilizer();
  private readonly temporalRegionTracker = new TemporalRegionTracker();
  private readonly previousPositionFallback = new PreviousPositionFallback();
  private readonly candidateResolver = new CandidateResolver();

  async analyze(frame: OffscreenInputFrame): Promise<FrameLayout> {
    const startedAt = performance.now();
    const videoRoiRect = extractVideoRoi(frame);
    const preprocessed = this.preprocessor.run(frame, videoRoiRect);
    const regionProposals = this.proposalGenerator.generate(preprocessed);
    const resolvedRegionProposals = this.candidateResolver.resolve(regionProposals);
    const temporalInput = resolvedRegionProposals.filter(isWeakProposal);
    const temporalInputIds = new Set(temporalInput.map((proposal) => proposal.id));
    const trackedProposals = this.candidateResolver.resolve(
      this.temporalRegionTracker.update(frame.timing.frameIndex, frame.timing.timestampSec, temporalInput)
    );
    const allRegionProposals = [
      ...trackedProposals,
      ...resolvedRegionProposals.filter((proposal) => !temporalInputIds.has(proposal.id))
    ].sort((a, b) => a.rect.y - b.rect.y);
    const weakCandidates = trackedProposals.filter((proposal) => proposal.status === "weak");
    const promotedRegions = trackedProposals.filter((proposal) => proposal.status === "promoted" || proposal.status === "final");
    const rejectedCandidates = allRegionProposals
      .filter((proposal) => proposal.status === "rejected")
      .map((proposal) => ({
        rect: proposal.rect,
        reason: proposal.rejectReason ?? proposal.reason ?? "REJECTED"
      }));
    const scoreRegions = promotedRegions.map((proposal, index) => this.proposalGenerator.toScoreRegion(proposal, index));
    const allStaffCandidates = promotedRegions.flatMap((proposal) => this.staffDetector.find(preprocessed, [this.proposalGenerator.toScoreRegion(proposal, 0)]));
    const scale = this.scaleEstimator.estimate(allStaffCandidates);
    const rawSystems = promotedRegions.flatMap((proposal) => this.detectSystemsInRegion(preprocessed, proposal, scale));
    let finalSystems = this.temporalStabilizer.update(frame.timing.frameIndex, rawSystems);

    if (finalSystems.length === 0) {
      finalSystems = this.previousPositionFallback.tryGet(frame.timing.timestampSec);
    }

    if (finalSystems.length > 0) {
      this.previousPositionFallback.update(finalSystems, frame.timing.timestampSec);
    }

    const processingTimeMs = performance.now() - startedAt;
    const confidence = finalSystems.length > 0 ? clamp(average(finalSystems.map((system) => system.confidence)), 0, 1) : 0;
    const regionDebug = this.temporalRegionTracker.getDebugInfo();
    const boxDebug = this.temporalStabilizer.getDebugInfo();
    const failureReason = inferFailureReason(regionProposals, weakCandidates, promotedRegions, finalSystems);

    return {
      frameId: frame.id,
      sessionId: frame.sessionId,
      timestampSec: frame.timing.timestampSec,
      scoreDetected: finalSystems.length > 0,
      scoreRegions,
      regionProposals: allRegionProposals,
      weakCandidates,
      promotedCandidates: promotedRegions,
      finalSystems,
      systems: finalSystems,
      confidence,
      scale,
      debug: {
        videoRoiRect,
        resizedFrameSize: {
          width: preprocessed.width,
          height: preprocessed.height
        },
        preprocessing: {
          grayscale: true,
          grayscaleGenerated: true,
          thresholdGenerated: true,
          edgeMapGenerated: true,
          thresholdMethod: "simple",
          analysisScale: preprocessed.analysisScale
        },
        regionProposals: allRegionProposals,
        weakCandidates,
        promotedRegions,
        promotedCandidates: promotedRegions,
        scoreRegionCandidates: scoreRegions,
        staffCandidates: allStaffCandidates,
        rejectedCandidates,
        temporal: {
          trackedBoxes: boxDebug.trackedBoxes,
          trackedRegions: regionDebug.trackedRegions,
          stableBoxCount: boxDebug.stableBoxCount,
          stableRegionCount: regionDebug.stableRegionCount
        },
        systems: finalSystems,
        finalSystems,
        failureReason,
        processingTimeMs
      }
    };
  }

  reset(): void {
    this.temporalStabilizer.reset();
    this.temporalRegionTracker.reset();
    this.previousPositionFallback.reset();
  }

  private detectSystemsInRegion(
    preprocessed: ReturnType<ImagePreprocessor["run"]>,
    proposal: ScoreRegionProposal,
    scaleHint: FrameLayout["scale"]
  ): DetectedSystem[] {
    const region = this.proposalGenerator.toScoreRegion(proposal, 0);
    const staffCandidates = this.staffDetector.find(preprocessed, [region]);
    const scale = staffCandidates.length > 0 ? this.scaleEstimator.estimate(staffCandidates) : scaleHint;
    const groupedSystems = this.systemGrouper.group(staffCandidates, scale);

    if (groupedSystems.length > 0) {
      return groupedSystems;
    }

    if (proposal.scores.temporalStabilityScore >= 0.7 || proposal.status === "promoted") {
      return [unknownSystemForProposal(proposal)];
    }

    return [];
  }
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function unknownSystemForProposal(proposal: ScoreRegionProposal): DetectedSystem {
  return {
    id: `${proposal.id}:unknown`,
    rect: proposal.rect,
    kind: "unknown",
    staffCandidates: [],
    confidence: Math.min(proposal.finalScores.finalScore, 0.72),
    source: "temporal_fallback",
    groupingReason: {
      staffCount: 0,
      xAlignmentScore: 0,
      widthSimilarityScore: 0,
      verticalGapScore: 0
    }
  };
}

function inferFailureReason(
  proposals: ScoreRegionProposal[],
  weakCandidates: ScoreRegionProposal[],
  promotedRegions: ScoreRegionProposal[],
  systems: DetectedSystem[]
): string | undefined {
  if (systems.length > 0) {
    return undefined;
  }

  if (proposals.length === 0) {
    return "NO_REGION_PROPOSAL";
  }

  if (weakCandidates.length === 0) {
    return "NO_WEAK_CANDIDATE";
  }

  if (promotedRegions.length === 0) {
    return "NO_PROMOTED_REGION_YET";
  }

  return "PROMOTED_REGION_WITHOUT_SYSTEM";
}
