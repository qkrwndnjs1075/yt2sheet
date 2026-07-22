import type { PendingScoreSample } from "../../shared/cluster-types";

export class PendingScoreBuffer {
  private pending: PendingScoreSample | null = null;

  set(sample: PendingScoreSample): void {
    this.pending = sample;
  }

  take(): PendingScoreSample | null {
    const current = this.pending;
    this.pending = null;
    return current;
  }

  peek(): PendingScoreSample | null {
    return this.pending;
  }

  clear(): void {
    this.pending = null;
  }

  count(): number {
    return this.pending ? 1 : 0;
  }
}
