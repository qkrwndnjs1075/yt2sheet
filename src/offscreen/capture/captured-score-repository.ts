import type { CapturedScoreSystem } from "../../shared/capture-types";

export interface CapturedScoreRepository {
  upsert(captured: CapturedScoreSystem): Promise<void>;
  findByClusterId(sessionId: string, clusterId: string): Promise<CapturedScoreSystem | null>;
  listBySession(sessionId: string): Promise<CapturedScoreSystem[]>;
  deleteByClusterId(sessionId: string, clusterId: string): Promise<void>;
}

export class InMemoryCapturedScoreRepository implements CapturedScoreRepository {
  private readonly captures = new Map<string, CapturedScoreSystem>();

  async upsert(captured: CapturedScoreSystem): Promise<void> {
    this.captures.set(key(captured.sessionId, captured.clusterId), captured);
  }

  async findByClusterId(sessionId: string, clusterId: string): Promise<CapturedScoreSystem | null> {
    return this.captures.get(key(sessionId, clusterId)) ?? null;
  }

  async listBySession(sessionId: string): Promise<CapturedScoreSystem[]> {
    return [...this.captures.values()]
      .filter((captured) => captured.sessionId === sessionId)
      .sort((a, b) => a.order - b.order);
  }

  async deleteByClusterId(sessionId: string, clusterId: string): Promise<void> {
    this.captures.delete(key(sessionId, clusterId));
  }
}

function key(sessionId: string, clusterId: string): string {
  return `${sessionId}:${clusterId}`;
}
