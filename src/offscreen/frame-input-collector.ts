import { captureError } from "../shared/errors";
import { logger } from "../shared/logger";
import type { RuntimeMessage, VideoProbeTick } from "../shared/messages";
import { SCORE_IDENTITY_CONFIG } from "../shared/score-identity-config";
import type { CaptureSession } from "../shared/types";
import type { FrameSink, OffscreenInputFrame } from "./frame-sink";

const MAX_CONSECUTIVE_SAMPLE_ERRORS = 3;
const VIDEO_METADATA_TIMEOUT_MS = 5000;
const HAVE_METADATA = 1;

type CollectorState = {
  session: CaptureSession;
  stream: MediaStream;
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  intervalId: number;
  frameIndex: number;
  consecutiveSampleErrors: number;
  latestTick: VideoProbeTick | null;
  samplingInProgress: boolean;
  samplingCompleted: Promise<void> | null;
};

export class FrameInputCollector {
  private state: CollectorState | null = null;
  private sink: FrameSink | null = null;

  setFrameSink(sink: FrameSink): void {
    this.sink = sink;
  }

  async start(session: CaptureSession, streamId: string): Promise<void> {
    await this.stop("stopped");
    let pendingStream: MediaStream | null = null;
    let pendingVideo: HTMLVideoElement | null = null;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: "tab",
            chromeMediaSourceId: streamId
          }
        } as MediaTrackConstraints
      });
      pendingStream = stream;
      const video = document.createElement("video");
      pendingVideo = video;
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.style.display = "none";
      video.srcObject = stream;
      document.body.append(video);

      await waitForVideo(video);

      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { willReadFrequently: false });

      if (!context) {
        throw new Error("Unable to create 2D canvas context.");
      }

      const intervalId = window.setInterval(() => {
        void this.sampleFrame();
      }, session.config.sampleIntervalMs);

      this.state = {
        session: { ...session, state: "running" },
        stream,
        video,
        canvas,
        context,
        intervalId,
        frameIndex: 0,
        consecutiveSampleErrors: 0,
        latestTick: null,
        samplingInProgress: false,
        samplingCompleted: null
      };

      await this.sink?.onSessionStarted(this.state.session);
      await this.sampleFrame();
    } catch (error) {
      pendingVideo?.remove();
      pendingStream?.getTracks().forEach((track) => track.stop());
      throw error;
    }
  }

  async stop(reason: "stopped" | "completed" | "error" = "stopped"): Promise<void> {
    const current = this.state;

    if (!current) {
      return;
    }

    window.clearInterval(current.intervalId);
    if (reason !== "error") {
      await current.samplingCompleted;
    }
    current.video.pause();
    current.video.srcObject = null;
    current.video.remove();
    current.stream.getTracks().forEach((track) => track.stop());

    const stoppedSession: CaptureSession = {
      ...current.session,
      state: reason === "completed" ? "completed" : reason === "error" ? "error" : "stopped",
      stats: {
        ...current.session.stats,
        framesSampled: current.frameIndex,
        endedAt: new Date().toISOString()
      }
    };

    this.state = null;
    await this.sink?.onSessionStopped(stoppedSession);
    await chrome.runtime.sendMessage<RuntimeMessage>({ type: "CAPTURE_STOPPED", sessionId: stoppedSession.id, reason });
  }

  updateTiming(tick: VideoProbeTick): void {
    if (this.state?.session.id === tick.sessionId) {
      this.state.latestTick = tick;
      this.state.session = {
        ...this.state.session,
        source: {
          ...this.state.session.source,
          currentTimeSec: tick.currentTimeSec,
          playbackRate: tick.playbackRate,
          paused: tick.paused,
          durationSec: tick.durationSec,
          videoRect: tick.videoRect,
          viewport: tick.viewport
        }
      };
    }
  }

  private async sampleFrame(): Promise<void> {
    const current = this.state;

    if (!current) {
      return;
    }

    if (!shouldSamplePlaybackTick(current.latestTick)) {
      return;
    }

    if (current.samplingInProgress) {
      current.session.stats.framesDropped += 1;
      return;
    }

    let finishSampling = (): void => {};
    current.samplingCompleted = new Promise<void>((resolve) => {
      finishSampling = resolve;
    });

    try {
      current.samplingInProgress = true;
      const width = current.video.videoWidth;
      const height = current.video.videoHeight;

      if (width === 0 || height === 0) {
        current.session.stats.framesDropped += 1;
        return;
      }

      current.canvas.width = width;
      current.canvas.height = height;
      current.context.drawImage(current.video, 0, 0, width, height);

      current.frameIndex += 1;
      const sampledAt = new Date().toISOString();
      const timestampSec = this.currentTimestampSec(sampledAt);
      const durationSec = current.session.source.durationSec;
      const nearEnd = isNearEnd(timestampSec, durationSec);
      current.session.stats = {
        ...current.session.stats,
        framesSampled: current.frameIndex,
        lastTimestampSec: timestampSec,
        lastFrameWidth: width,
        lastFrameHeight: height
      };

      const frame: OffscreenInputFrame = {
        id: `${current.session.id}:${current.frameIndex}`,
        sessionId: current.session.id,
        source: {
          platform: "youtube",
          videoId: current.session.source.videoId,
          url: current.session.source.url,
          title: current.session.source.title
        },
        timing: {
          timestampSec,
          sampledAt,
          frameIndex: current.frameIndex,
          playbackRate: current.session.source.playbackRate
        },
        image: {
          width,
          height,
          bitmapRef: current.canvas
        },
        meta: {
          sampleIntervalMs: current.session.config.sampleIntervalMs,
          tabId: current.session.tabId,
          devicePixelRatio: window.devicePixelRatio,
          videoRect: current.session.source.videoRect,
          viewport: current.session.source.viewport,
          roiConfig: current.session.config.roiConfig,
          durationSec,
          nearEnd,
          videoEnded: nearEnd && durationSec !== null && timestampSec >= durationSec
        }
      };

      await this.sink?.onFrame(frame);
      current.consecutiveSampleErrors = 0;
    } catch (error) {
      current.session.stats.framesDropped += 1;
      current.consecutiveSampleErrors += 1;
      logger.warn("Frame sampling dropped", {
        sessionId: current.session.id,
        framesDropped: current.session.stats.framesDropped,
        consecutiveSampleErrors: current.consecutiveSampleErrors
      });

      if (current.consecutiveSampleErrors >= MAX_CONSECUTIVE_SAMPLE_ERRORS) {
        await this.sink?.onError(captureError("SAMPLING_LOOP_ERROR", "Frame sampling failed repeatedly.", error, current.session.id));
        await this.stop("error");
      }
    } finally {
      current.samplingInProgress = false;
      current.samplingCompleted = null;
      finishSampling();
    }
  }

  private currentTimestampSec(sampledAt: string): number {
    const current = this.state;

    if (!current) {
      return 0;
    }

    const tick = current.latestTick;

    if (!tick) {
      return current.session.config.startTimeSec;
    }

    const sampledAtMs = Date.parse(sampledAt);
    const tickAtMs = Date.parse(tick.wallClockAt);
    const elapsedSec = Number.isFinite(sampledAtMs) && Number.isFinite(tickAtMs) ? Math.max(0, (sampledAtMs - tickAtMs) / 1000) : 0;
    return tick.currentTimeSec + elapsedSec * tick.playbackRate;
  }
}

export function shouldSamplePlaybackTick(tick: VideoProbeTick | null): boolean {
  return tick !== null && !tick.paused && tick.playbackRate > 0;
}

function isNearEnd(timestampSec: number, durationSec: number | null): boolean {
  if (durationSec === null || !Number.isFinite(durationSec) || durationSec <= 0) {
    return false;
  }

  return durationSec * 1000 - timestampSec * 1000 <= SCORE_IDENTITY_CONFIG.endGate.nearEndWindowMs;
}

function waitForVideo(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for tab stream video metadata."));
    }, VIDEO_METADATA_TIMEOUT_MS);

    const cleanup = () => {
      window.clearTimeout(timeoutId);
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("error", onError);
    };
    const onLoadedMetadata = () => {
      cleanup();
      void video.play().then(resolve, reject);
    };
    const onError = () => {
      cleanup();
      reject(new Error("Tab stream video failed to load."));
    };

    video.addEventListener("loadedmetadata", onLoadedMetadata, { once: true });
    video.addEventListener("error", onError, { once: true });

    if (video.readyState >= HAVE_METADATA) {
      onLoadedMetadata();
    }
  });
}
