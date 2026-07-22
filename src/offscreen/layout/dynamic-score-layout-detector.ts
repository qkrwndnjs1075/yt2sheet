import { clamp } from "../../shared/geometry";
import type { AiJudgeDebugInfo, DetectedSystem, FrameLayout, ScoreRegionProposal } from "../../shared/layout-types";
import type { OffscreenInputFrame } from "../frame-sink";
import { AiJudgeCache } from "./ai/ai-judge-cache";
import { CandidateContactSheetBuilder } from "./ai/candidate-contact-sheet-builder";
import {
  AI_JUDGE_MIN_INTERVAL_MS,
  AI_JUDGE_ONLY_WHEN_CANDIDATES_CHANGED,
  MAX_CANDIDATES_PER_CONTACT_SHEET,
  type CandidateForJudge,
  type CandidateJudgeResultForProposal,
  type ClaudeCandidateJudgeResult
} from "./ai/candidate-judge-types";
import { ClaudeCandidateJudge } from "./ai/claude-candidate-judge";
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

type CandidateJudge = {
  isEnabled(): Promise<boolean>;
  judge(contactSheet: Awaited<ReturnType<CandidateContactSheetBuilder["build"]>>, candidates: CandidateForJudge[]): Promise<ClaudeCandidateJudgeResult>;
};

type DynamicScoreLayoutDetectorOptions = {
  aiJudge?: CandidateJudge;
  aiJudgeCache?: AiJudgeCache;
  contactSheetBuilder?: CandidateContactSheetBuilder;
  now?: () => number;
};

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
  private readonly aiJudge: CandidateJudge;
  private readonly aiJudgeCache: AiJudgeCache;
  private readonly contactSheetBuilder: CandidateContactSheetBuilder;
  private readonly now: () => number;
  private lastAiJudgeAt = Number.NEGATIVE_INFINITY;
  private lastAiCandidateSignature = "";

  constructor(options: DynamicScoreLayoutDetectorOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.aiJudge = options.aiJudge ?? new ClaudeCandidateJudge();
    this.aiJudgeCache = options.aiJudgeCache ?? new AiJudgeCache(this.now);
    this.contactSheetBuilder = options.contactSheetBuilder ?? new CandidateContactSheetBuilder();
  }

  async analyze(frame: OffscreenInputFrame): Promise<FrameLayout> {
    const startedAt = performance.now();
    const videoRoiRect = extractVideoRoi(frame);
    const preprocessed = this.preprocessor.run(frame, videoRoiRect);
    const regionProposals = this.proposalGenerator.generate(preprocessed);
    const aiJudgeContext = await this.judgeCandidates(frame, regionProposals);
    const resolvedRegionProposals = this.candidateResolver.resolve({
      proposals: regionProposals,
      aiResults: aiJudgeContext.results
    });
    const temporalInput = resolvedRegionProposals.filter(isWeakProposal);
    const temporalInputIds = new Set(temporalInput.map((proposal) => proposal.id));
    const trackedProposals = this.candidateResolver.resolve({
      proposals: this.temporalRegionTracker.update(frame.timing.frameIndex, frame.timing.timestampSec, temporalInput),
      aiResults: aiJudgeContext.results
    });
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
        aiJudge: aiJudgeContext.debug,
        failureReason,
        processingTimeMs
      }
    };
  }

  reset(): void {
    this.temporalStabilizer.reset();
    this.temporalRegionTracker.reset();
    this.previousPositionFallback.reset();
    this.aiJudgeCache.clear();
    this.lastAiJudgeAt = Number.NEGATIVE_INFINITY;
    this.lastAiCandidateSignature = "";
  }

  private async judgeCandidates(
    frame: OffscreenInputFrame,
    proposals: ScoreRegionProposal[]
  ): Promise<{ results: CandidateJudgeResultForProposal[]; debug: AiJudgeDebugInfo }> {
    const videoId = frame.source.videoId;
    const selectedCandidates = selectCandidatesForAiJudge(frame, proposals);
    const debug: AiJudgeDebugInfo = {
      enabled: false,
      called: false,
      contactSheetCandidateIds: selectedCandidates.map((candidate) => candidate.id),
      cacheHits: [],
      cacheMisses: []
    };

    if (selectedCandidates.length === 0) {
      return {
        results: [],
        debug: {
          ...debug,
          skippedReason: "NO_AI_CANDIDATES"
        }
      };
    }

    const enabled = await this.aiJudge.isEnabled();
    debug.enabled = enabled;

    if (!enabled) {
      this.aiJudgeCache.clear();
      return {
        results: [],
        debug: {
          ...debug,
          skippedReason: "AI_JUDGE_NOT_CONFIGURED"
        }
      };
    }

    const cachedResults: CandidateJudgeResultForProposal[] = [];
    const candidatesToJudge: CandidateForJudge[] = [];

    for (const candidate of selectedCandidates) {
      const cached = this.aiJudgeCache.get(videoId, candidate);
      if (cached) {
        debug.cacheHits.push(cached.key);
        cachedResults.push({
          ...cached.result,
          proposalId: candidate.proposalId
        });
      } else {
        debug.cacheMisses.push(`${candidate.proposalId}:${candidate.id}`);
        candidatesToJudge.push(candidate);
      }
    }

    if (candidatesToJudge.length === 0) {
      return {
        results: cachedResults,
        debug: {
          ...debug,
          skippedReason: "AI_JUDGE_CACHE_HIT"
        }
      };
    }

    const now = this.now();
    const signature = candidateSignature(candidatesToJudge);
    if (now - this.lastAiJudgeAt < AI_JUDGE_MIN_INTERVAL_MS) {
      return {
        results: cachedResults,
        debug: {
          ...debug,
          skippedReason: "AI_JUDGE_MIN_INTERVAL"
        }
      };
    }

    if (AI_JUDGE_ONLY_WHEN_CANDIDATES_CHANGED && signature === this.lastAiCandidateSignature && cachedResults.length > 0) {
      return {
        results: cachedResults,
        debug: {
          ...debug,
          skippedReason: "AI_JUDGE_CANDIDATES_UNCHANGED"
        }
      };
    }

    const startedAt = performance.now();
    this.lastAiJudgeAt = now;
    try {
      const contactSheet = await this.contactSheetBuilder.build(frame, candidatesToJudge);
      const aiResult = await this.aiJudge.judge(contactSheet, candidatesToJudge);
      this.lastAiCandidateSignature = signature;
      const judgedResults = mapJudgeResultsToProposals(candidatesToJudge, aiResult);

      for (const result of judgedResults) {
        const candidate = candidatesToJudge.find((item) => item.proposalId === result.proposalId);
        if (candidate) {
          this.aiJudgeCache.set(videoId, candidate, result);
        }
      }

      return {
        results: [...cachedResults, ...judgedResults],
        debug: {
          ...debug,
          called: true,
          contactSheetCandidateIds: candidatesToJudge.map((candidate) => candidate.id),
          latencyMs: performance.now() - startedAt,
          results: judgedResults.map((result) => ({
            candidateId: result.candidateId,
            label: result.label,
            confidence: result.confidence,
            reason: result.reason
          }))
        }
      };
    } catch (error) {
      return {
        results: cachedResults,
        debug: {
          ...debug,
          called: true,
          latencyMs: performance.now() - startedAt,
          error: error instanceof Error ? error.message : String(error)
        }
      };
    }
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

export function selectCandidatesForAiJudge(frame: OffscreenInputFrame, proposals: ScoreRegionProposal[]): CandidateForJudge[] {
  const letters = "ABCDEFGHIJKL".split("");

  return proposals
    .filter((proposal) => proposal.status !== "rejected")
    .filter((proposal) => isCandidateSizeReasonable(frame, proposal))
    .sort((a, b) => {
      const ruleDiff = (b.ruleScores?.finalRuleScore ?? b.scores.finalScore) - (a.ruleScores?.finalRuleScore ?? a.scores.finalScore);
      if (Math.abs(ruleDiff) > 0.001) {
        return ruleDiff;
      }
      return (b.scores.temporalStabilityScore ?? 0) - (a.scores.temporalStabilityScore ?? 0);
    })
    .slice(0, MAX_CANDIDATES_PER_CONTACT_SHEET)
    .map((proposal, index) => ({
      id: letters[index],
      proposalId: proposal.id,
      rect: proposal.rect,
      source: proposal.source,
      ruleScore: proposal.ruleScores?.finalRuleScore ?? proposal.scores.finalScore
    }));
}

function isCandidateSizeReasonable(frame: OffscreenInputFrame, proposal: ScoreRegionProposal): boolean {
  const frameArea = Math.max(1, frame.image.width * frame.image.height);
  const proposalArea = proposal.rect.width * proposal.rect.height;
  return proposal.rect.width >= 40 &&
    proposal.rect.height >= 12 &&
    proposal.rect.width <= frame.image.width * 1.05 &&
    proposal.rect.height <= frame.image.height * 0.8 &&
    proposalArea <= frameArea * 0.7;
}

function mapJudgeResultsToProposals(candidates: CandidateForJudge[], aiResult: ClaudeCandidateJudgeResult): CandidateJudgeResultForProposal[] {
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const resultIds = new Set(aiResult.candidates.map((result) => result.candidateId));
  const missingIds = candidates.map((candidate) => candidate.id).filter((id) => !resultIds.has(id));
  const unknownIds = aiResult.candidates.map((result) => result.candidateId).filter((id) => !candidateById.has(id));
  const duplicateIds = findDuplicateIds(aiResult.candidates.map((result) => result.candidateId));

  if (missingIds.length > 0 || unknownIds.length > 0 || duplicateIds.length > 0) {
    throw new Error(`AI judge returned invalid candidate labels. Missing: ${missingIds.join(",") || "-"}; unknown: ${unknownIds.join(",") || "-"}; duplicate: ${duplicateIds.join(",") || "-"}.`);
  }

  return aiResult.candidates.flatMap((result) => {
    const candidate = candidateById.get(result.candidateId);
    return candidate
      ? [{
          ...result,
          proposalId: candidate.proposalId
        }]
      : [];
  });
}

function findDuplicateIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const id of ids) {
    if (seen.has(id)) {
      duplicates.add(id);
    }
    seen.add(id);
  }

  return [...duplicates];
}

function candidateSignature(candidates: CandidateForJudge[]): string {
  return candidates
    .map((candidate) => `${candidate.source}:${Math.round(candidate.rect.x / 16)}:${Math.round(candidate.rect.y / 16)}:${Math.round(candidate.rect.width / 16)}:${Math.round(candidate.rect.height / 16)}`)
    .join("|");
}

function unknownSystemForProposal(proposal: ScoreRegionProposal): DetectedSystem {
  return {
    id: `${proposal.id}:unknown`,
    rect: proposal.rect,
    kind: "unknown",
    staffCandidates: [],
    confidence: Math.min(proposal.finalScores?.finalScore ?? proposal.scores.finalScore, 0.72),
    source: systemSourceForProposal(proposal),
    groupingReason: {
      staffCount: 0,
      xAlignmentScore: 0,
      widthSimilarityScore: 0,
      verticalGapScore: 0
    }
  };
}

function systemSourceForProposal(proposal: ScoreRegionProposal): DetectedSystem["source"] {
  if (proposal.ai?.label === "score_system") {
    return "ai_score_system";
  }

  if (proposal.ai?.label === "score_region") {
    return "ai_score_region";
  }

  return "temporal_fallback";
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
