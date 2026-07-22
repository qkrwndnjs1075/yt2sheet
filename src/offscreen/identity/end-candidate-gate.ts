import type { ScoreClusterUpdate } from "../../shared/cluster-types";
import type { NormalizedScoreImage, ScoreFingerprint } from "../../shared/fingerprint-types";
import type { RoiSample } from "../../shared/roi-types";
import { SCORE_IDENTITY_CONFIG } from "../../shared/score-identity-config";
import { compareScoreFingerprints } from "./score-similarity";
import type { ClusterInput, ScoreClusterer } from "./score-clusterer";
import { isScoreLikeEndCandidate, measureEndCandidate, type EndCandidateMetrics } from "./end-candidate-metrics";

type GateInput = ClusterInput & {
  normalized: NormalizedScoreImage;
  nearEnd: boolean;
  videoEnded: boolean;
};

type PendingEndCandidate = {
  input: ClusterInput;
  metrics: EndCandidateMetrics;
};

export class EndCandidateGate {
  private pending: PendingEndCandidate | null = null;

  constructor(private readonly clusterer: ScoreClusterer) {}

  handle(input: GateInput): ScoreClusterUpdate {
    if (!input.nearEnd && !input.videoEnded) {
      this.pending = null;
      return this.clusterer.handleFingerprint(input);
    }

    const match = this.clusterer.previewFingerprint(input.fingerprint);
    if (match?.similarity.decision !== "different" && match) {
      this.pending = null;
      const update = this.clusterer.handleFingerprint(input);
      return withEndGate(update, "none", "matched_existing_score", update.exported ?? update.decision !== "maybe_same", this.pendingCount());
    }

    const currentMetrics = measureEndCandidate(input.normalized);
    if (!isScoreLikeEndCandidate(currentMetrics, this.pending?.metrics ?? null, SCORE_IDENTITY_CONFIG.endGate)) {
      this.pending = null;
      return this.syntheticUpdate("discarded_overlay", "end_sample_is_not_score_like", input.sample, input.fingerprint);
    }

    const currentToPending = this.pending ? compareScoreFingerprints(input.fingerprint, this.pending.input.fingerprint) : null;
    if (
      this.pending &&
      currentToPending?.decision === "same" &&
      SCORE_IDENTITY_CONFIG.endGate.endCandidateRequiredConfirmations <= 2
    ) {
      const firstObservation = this.pending.input;
      this.pending = null;
      return withEndGate(
        this.clusterer.confirmDifferent(input, firstObservation),
        "confirmed",
        "end_candidate_confirmed_by_consecutive_sample",
        true,
        this.pendingCount()
      );
    }

    if (SCORE_IDENTITY_CONFIG.endGate.endCandidateRequiredConfirmations <= 1) {
      this.pending = null;
      return withEndGate(this.clusterer.confirmDifferent(input), "confirmed", "end_candidate_single_confirmation", true, this.pendingCount());
    }

    this.pending = {
      input,
      metrics: currentMetrics
    };

    return this.syntheticUpdate("held", "end_candidate_waiting_for_confirmation", input.sample, input.fingerprint);
  }

  flushUnconfirmed(): ScoreClusterUpdate | null {
    const pending = this.pending;
    if (!pending) {
      return null;
    }

    this.pending = null;
    return this.syntheticUpdate("discarded_unconfirmed", "capture_stopped_before_end_candidate_confirmation", pending.input.sample, pending.input.fingerprint);
  }

  pendingCount(): number {
    return this.pending ? 1 : 0;
  }

  reset(): void {
    this.pending = null;
  }

  private syntheticUpdate(
    endGate: ScoreClusterUpdate["endGate"],
    reason: string,
    sample: RoiSample,
    _fingerprint: ScoreFingerprint
  ): ScoreClusterUpdate {
    return {
      decision: "different",
      sample,
      clusters: this.clusterer.getClusters(),
      acceptedClusters: this.clusterer.getAcceptedClusters(),
      pendingCount: this.clusterer.getPendingCount(),
      endGate,
      endGateReason: reason,
      exported: false,
      pendingEndCandidateCount: this.pendingCount()
    };
  }
}

function withEndGate(
  update: ScoreClusterUpdate,
  endGate: ScoreClusterUpdate["endGate"],
  reason: string,
  exported: boolean,
  pendingEndCandidateCount: number
): ScoreClusterUpdate {
  return {
    ...update,
    endGate,
    endGateReason: reason,
    exported,
    pendingEndCandidateCount
  };
}
