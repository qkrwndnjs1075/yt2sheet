import type { PendingScoreSample, ScoreCluster, ScoreClusterUpdate } from "../../shared/cluster-types";
import type { ScoreFingerprint, ScoreSimilarityDebug } from "../../shared/fingerprint-types";
import type { RoiSample } from "../../shared/roi-types";
import { SCORE_IDENTITY_CONFIG } from "../../shared/score-identity-config";
import { compareScoreFingerprints } from "./score-similarity";
import { PendingScoreBuffer } from "./pending-score-buffer";

export type ClusterInput = {
  sample: RoiSample;
  fingerprint: ScoreFingerprint;
  qualityScore: number;
  imageBlobId: string;
};

// allow: SIZE_OK - score clustering transitions share one mutable state machine.
export class ScoreClusterer {
  private clusters: ScoreCluster[] = [];
  private activeClusterId: string | null = null;
  private nextClusterNumber = 1;

  constructor(private readonly pendingBuffer = new PendingScoreBuffer()) {}

  addSample(sample: RoiSample, fingerprint: ScoreFingerprint, qualityScore: number): ScoreClusterUpdate {
    return this.handleFingerprint({
      sample,
      fingerprint,
      qualityScore,
      imageBlobId: representativeBlobId(sample.id)
    });
  }

  handleFingerprint(input: ClusterInput): ScoreClusterUpdate {
    const pendingResult = this.resolvePending(input);
    if (pendingResult) {
      return pendingResult;
    }

    const match = this.findMatch(input.fingerprint);
    if (match?.similarity.decision === "same") {
      const previousRepresentativeId = match.cluster.representativeSampleId;
      const previousRepresentativeImageBlobId = match.cluster.representativeImageBlobId;
      const cluster = this.updateClusterRepresentative(match.cluster, input);
      this.activeClusterId = cluster.id;
      return this.toUpdate("same", input.sample, {
        cluster,
        matchedClusterId: cluster.id,
        representativeSample: cluster.representativeSampleId !== previousRepresentativeId ? input.sample : undefined,
        previousRepresentativeImageBlobId: cluster.representativeImageBlobId !== previousRepresentativeImageBlobId ? previousRepresentativeImageBlobId : undefined,
        similarity: match.similarity
      });
    }

    if (match?.similarity.decision === "maybe_same") {
      const pending = this.createPending(input, "maybe_same", match.cluster.id);
      this.pendingBuffer.set(pending);
      return this.toUpdate("maybe_same", input.sample, { pending, matchedClusterId: match.cluster.id, similarity: match.similarity, exported: false });
    }

    if (Number(SCORE_IDENTITY_CONFIG.cluster.minAcceptSeenCount) <= 1) {
      return this.confirmDifferent(input);
    }

    const pending = this.createPending(input, "different");
    this.pendingBuffer.set(pending);
    return this.toUpdate("different", input.sample, { pending, similarity: match?.similarity, exported: false });
  }

  previewFingerprint(fingerprint: ScoreFingerprint): { cluster: ScoreCluster; similarity: ScoreSimilarityDebug } | null {
    return this.findMatch(fingerprint);
  }

  confirmDifferent(input: ClusterInput, firstObservation?: ClusterInput): ScoreClusterUpdate {
    const cluster = this.createCluster(firstObservation ?? input);
    const previousRepresentativeId = cluster.representativeSampleId;
    const previousRepresentativeImageBlobId = cluster.representativeImageBlobId;
    if (firstObservation) {
      this.updateClusterRepresentative(cluster, input);
    }
    this.activeClusterId = cluster.id;
    return this.toUpdate("different", input.sample, {
      cluster,
      newClusterId: cluster.id,
      representativeSample: firstObservation
        ? representativeSampleFor(cluster.representativeSampleId, previousRepresentativeId, firstObservation.sample, input.sample) ?? firstObservation.sample
        : input.sample,
      previousRepresentativeImageBlobId: cluster.representativeImageBlobId !== previousRepresentativeImageBlobId ? previousRepresentativeImageBlobId : undefined,
      exported: true
    });
  }

  reset(): void {
    this.clusters = [];
    this.activeClusterId = null;
    this.nextClusterNumber = 1;
    this.pendingBuffer.clear();
  }

  getClusters(): ScoreCluster[] {
    return [...this.clusters];
  }

  getAcceptedClusters(): ScoreCluster[] {
    return this.clusters.filter((cluster) => cluster.status === "accepted");
  }

  getPendingCount(): number {
    return this.pendingBuffer.count();
  }

  private resolvePending(input: ClusterInput): ScoreClusterUpdate | null {
    const pending = this.pendingBuffer.take();
    if (!pending) {
      return null;
    }

    const targetCluster = pending.matchedClusterId ? this.findCluster(pending.matchedClusterId) : null;
    if (targetCluster) {
      const currentToTarget = compareScoreFingerprints(input.fingerprint, targetCluster.fingerprint);
      if (currentToTarget.decision === "same") {
        const previousRepresentativeId = targetCluster.representativeSampleId;
        const previousRepresentativeImageBlobId = targetCluster.representativeImageBlobId;
        this.updateClusterRepresentative(targetCluster, pendingToClusterInput(pending));
        const cluster = this.updateClusterRepresentative(targetCluster, input);
        const discardedImageBlobIds = pending.imageBlobId !== cluster.representativeImageBlobId ? [pending.imageBlobId] : [];
        this.activeClusterId = cluster.id;
        return this.toUpdate("same", input.sample, {
          cluster,
          matchedClusterId: cluster.id,
          representativeSample: representativeSampleFor(cluster.representativeSampleId, previousRepresentativeId, pending.sample, input.sample),
          previousRepresentativeImageBlobId: cluster.representativeImageBlobId !== previousRepresentativeImageBlobId ? previousRepresentativeImageBlobId : undefined,
          discardedImageBlobIds,
          similarity: currentToTarget
        });
      }
    }

    const currentToPending = compareScoreFingerprints(input.fingerprint, pending.fingerprint);
    if (currentToPending.decision === "same") {
      return {
        ...this.confirmDifferent(input, pendingToClusterInput(pending)),
        similarity: currentToPending
      };
    }

    if (currentToPending.decision === "maybe_same") {
      const refreshedPending = this.createPending(input, pending.reason, pending.matchedClusterId);
      this.pendingBuffer.set(refreshedPending);
      return this.toUpdate("maybe_same", input.sample, {
        pending: refreshedPending,
        matchedClusterId: pending.matchedClusterId,
        discardedImageBlobIds: [pending.imageBlobId],
        similarity: currentToPending
      });
    }

    const currentMatch = this.findMatch(input.fingerprint);
    if (currentMatch?.similarity.decision === "same") {
      const previousRepresentativeImageBlobId = currentMatch.cluster.representativeImageBlobId;
      const cluster = this.updateClusterRepresentative(currentMatch.cluster, input);
      this.activeClusterId = cluster.id;
      return this.toUpdate("same", input.sample, {
        cluster,
        matchedClusterId: cluster.id,
        previousRepresentativeImageBlobId: cluster.representativeImageBlobId !== previousRepresentativeImageBlobId ? previousRepresentativeImageBlobId : undefined,
        discardedImageBlobIds: [pending.imageBlobId],
        similarity: currentMatch.similarity
      });
    }

    const pendingDurationMs = (input.sample.timestampSec - pending.createdAtSec) * 1000;
    if (
      pending.reason === "different" &&
      currentMatch === null &&
      this.getAcceptedClusters().length > 0 &&
      pendingDurationMs >= SCORE_IDENTITY_CONFIG.sampling.minStableDurationMs
    ) {
      const nextPending = this.createPending(input, "different");
      this.pendingBuffer.set(nextPending);
      return {
        ...this.confirmDifferent(pendingToClusterInput(pending)),
        pending: nextPending,
        similarity: currentToPending
      };
    }

    const refreshedPending = this.createPending(
      input,
      currentMatch?.similarity.decision === "maybe_same" ? "maybe_same" : "different",
      currentMatch?.similarity.decision === "maybe_same" ? currentMatch.cluster.id : undefined
    );
    this.pendingBuffer.set(refreshedPending);
    return this.toUpdate(currentMatch?.similarity.decision === "maybe_same" ? "maybe_same" : "different", input.sample, {
      pending: refreshedPending,
      matchedClusterId: currentMatch?.similarity.decision === "maybe_same" ? currentMatch.cluster.id : undefined,
      discardedImageBlobIds: [pending.imageBlobId],
      similarity: currentMatch?.similarity,
      exported: false
    });
  }

  private findMatch(fingerprint: ScoreFingerprint): { cluster: ScoreCluster; similarity: ScoreSimilarityDebug } | null {
    const ordered = this.orderedClusters();
    let bestMaybe: { cluster: ScoreCluster; similarity: ScoreSimilarityDebug } | null = null;

    for (const cluster of ordered) {
      const similarity = compareScoreFingerprints(fingerprint, cluster.fingerprint);
      if (similarity.decision === "same") {
        return { cluster, similarity };
      }

      if (similarity.decision === "maybe_same" && !bestMaybe && this.isRecentOrActive(cluster)) {
        bestMaybe = { cluster, similarity };
      }
    }

    return bestMaybe;
  }

  private orderedClusters(): ScoreCluster[] {
    const active = this.activeClusterId ? this.findCluster(this.activeClusterId) : null;
    const recent = this.clusters
      .filter((cluster) => cluster.status === "accepted" && cluster.id !== active?.id)
      .sort((a, b) => b.lastSeenSec - a.lastSeenSec)
      .slice(0, SCORE_IDENTITY_CONFIG.cluster.recentAcceptedClusterCompareLimit);
    const older = this.clusters.filter((cluster) => cluster !== active && !recent.includes(cluster));
    return [...(active ? [active] : []), ...recent, ...older];
  }

  private isRecentOrActive(cluster: ScoreCluster): boolean {
    if (cluster.id === this.activeClusterId) {
      return true;
    }

    return this.clusters
      .filter((item) => item.status === "accepted")
      .sort((a, b) => b.lastSeenSec - a.lastSeenSec)
      .slice(0, SCORE_IDENTITY_CONFIG.cluster.recentAcceptedClusterCompareLimit)
      .some((item) => item.id === cluster.id);
  }

  private createPending(
    input: ClusterInput,
    reason: string,
    matchedClusterId?: string
  ): PendingScoreSample {
    return {
      sample: input.sample,
      fingerprint: input.fingerprint,
      qualityScore: input.qualityScore,
      imageBlobId: input.imageBlobId,
      createdAtSec: input.sample.timestampSec,
      reason,
      ...(matchedClusterId ? { matchedClusterId } : {})
    };
  }

  private createCluster(input: ClusterInput): ScoreCluster {
    const cluster: ScoreCluster = {
      id: `score_cluster_${this.nextClusterNumber}`,
      sessionId: input.sample.sessionId,
      firstSeenSec: input.sample.timestampSec,
      lastSeenSec: input.sample.timestampSec,
      seenCount: 1,
      representativeSampleId: input.sample.id,
      representativeImageBlobId: input.imageBlobId,
      fingerprint: input.fingerprint,
      bestQualityScore: input.qualityScore,
      status: "accepted"
    };
    this.nextClusterNumber += 1;
    this.clusters.push(cluster);
    return cluster;
  }

  private updateClusterRepresentative(
    cluster: ScoreCluster,
    input: ClusterInput
  ): ScoreCluster {
    cluster.seenCount += 1;
    cluster.lastSeenSec = input.sample.timestampSec;

    if (input.qualityScore > cluster.bestQualityScore) {
      cluster.bestQualityScore = input.qualityScore;
      cluster.representativeSampleId = input.sample.id;
      cluster.representativeImageBlobId = input.imageBlobId;
      cluster.fingerprint = input.fingerprint;
    }

    return cluster;
  }

  private findCluster(id: string): ScoreCluster | null {
    return this.clusters.find((cluster) => cluster.id === id) ?? null;
  }

  private toUpdate(
    decision: ScoreClusterUpdate["decision"],
    sample: RoiSample,
    patch: Partial<ScoreClusterUpdate>
  ): ScoreClusterUpdate {
    return {
      decision,
      sample,
      clusters: this.getClusters(),
      acceptedClusters: this.getAcceptedClusters(),
      pendingCount: this.pendingBuffer.count(),
      exported: decision !== "maybe_same",
      ...patch
    };
  }
}

function representativeBlobId(sampleId: string): string {
  return `roi-representative:${sampleId}`;
}

function pendingToClusterInput(pending: PendingScoreSample): ClusterInput {
  return {
    sample: pending.sample,
    fingerprint: pending.fingerprint,
    qualityScore: pending.qualityScore,
    imageBlobId: pending.imageBlobId
  };
}

function representativeSampleFor(
  representativeSampleId: string,
  previousRepresentativeId: string,
  pendingSample: RoiSample,
  currentSample: RoiSample
): RoiSample | undefined {
  if (representativeSampleId === previousRepresentativeId) {
    return undefined;
  }

  if (representativeSampleId === currentSample.id) {
    return currentSample;
  }

  if (representativeSampleId === pendingSample.id) {
    return pendingSample;
  }

  return undefined;
}
