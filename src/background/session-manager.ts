import { DEFAULT_SAMPLE_INTERVAL_MS, type CaptureSession, type CaptureState, type VideoSourceInfo } from "../shared/types";
import type { ScoreRoiConfig } from "../shared/roi-types";

const CURRENT_SESSION_KEY = "currentCaptureSession";

export class SessionManager {
  private currentSession: CaptureSession | null = null;

  async start(tabId: number, source: VideoSourceInfo, roiConfig?: ScoreRoiConfig): Promise<CaptureSession> {
    const now = new Date().toISOString();
    const session: CaptureSession = {
      id: crypto.randomUUID(),
      tabId,
      source,
      config: {
        sampleIntervalMs: DEFAULT_SAMPLE_INTERVAL_MS,
        startTimeSec: source.currentTimeSec,
        endTimeSec: null,
        captureVideoOnly: true,
        persistRawFrames: false,
        ...(roiConfig ? { roiConfig } : {})
      },
      state: "starting",
      stats: {
        framesSampled: 0,
        framesDropped: 0,
        startedAt: now
      }
    };

    await this.persist(session);
    return session;
  }

  async getCurrentSession(): Promise<CaptureSession | null> {
    if (this.currentSession) {
      return this.currentSession;
    }

    const stored = await chrome.storage.session.get(CURRENT_SESSION_KEY);
    this.currentSession = (stored[CURRENT_SESSION_KEY] as CaptureSession | undefined) ?? null;
    return this.currentSession;
  }

  async setState(sessionId: string, state: CaptureState): Promise<CaptureSession | null> {
    const session = await this.getCurrentSession();

    if (!session || session.id !== sessionId) {
      return null;
    }

    const next: CaptureSession = {
      ...session,
      state,
      stats: terminalState(state) ? { ...session.stats, endedAt: session.stats.endedAt ?? new Date().toISOString() } : session.stats
    };

    await this.persist(next);
    return next;
  }

  async updateStats(sessionId: string, patch: Partial<CaptureSession["stats"]>): Promise<CaptureSession | null> {
    const session = await this.getCurrentSession();

    if (!session || session.id !== sessionId) {
      return null;
    }

    const next = {
      ...session,
      stats: {
        ...session.stats,
        ...patch
      }
    };

    await this.persist(next);
    return next;
  }

  async clear(sessionId: string): Promise<void> {
    const session = await this.getCurrentSession();

    if (!session || session.id !== sessionId) {
      return;
    }

    this.currentSession = null;
    await chrome.storage.session.remove(CURRENT_SESSION_KEY);
  }

  private async persist(session: CaptureSession): Promise<void> {
    this.currentSession = session;
    await chrome.storage.session.set({ [CURRENT_SESSION_KEY]: session });
  }
}

function terminalState(state: CaptureState): boolean {
  return state === "stopped" || state === "completed" || state === "error";
}
