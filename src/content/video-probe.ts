type ProbeMessage =
  | { type: "GET_VIDEO_SOURCE_INFO" }
  | { type: "START_VIDEO_PROBE"; sessionId: string; tabId: number; sampleIntervalMs: number }
  | { type: "STOP_VIDEO_PROBE"; sessionId: string };

type ProbeState = {
  intervalId: number | null;
  sessionId: string | null;
  tabId: number | null;
  listenerRegistered: boolean;
};

type VideoSourceInfo = {
  platform: "youtube";
  url: string;
  videoId: string;
  title: string;
  durationSec: number | null;
  currentTimeSec: number;
  playbackRate: number;
  paused: boolean;
  videoRect?: VideoElementRect;
  viewport?: ViewportInfo;
};

type VideoElementRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type ViewportInfo = {
  width: number;
  height: number;
  devicePixelRatio: number;
};

type ProbeResponse =
  | { ok: true; source: VideoSourceInfo }
  | { ok: false; error: { code: "VIDEO_ELEMENT_NOT_FOUND" | "NOT_YOUTUBE_WATCH_PAGE"; message: string } };

declare global {
  interface Window {
    __scoreFrameProbe?: ProbeState;
  }
}

const state = (window.__scoreFrameProbe ??= {
  intervalId: null,
  sessionId: null,
  tabId: null,
  listenerRegistered: false
});

const PLAYER_OVERLAY_STYLE_ID = "score-frame-player-overlay-suppression";
const PLAYER_OVERLAY_SELECTORS = [
  ".ytp-chrome-top",
  ".ytp-chrome-bottom",
  ".ytp-gradient-top",
  ".ytp-gradient-bottom",
  ".ytp-tooltip",
  ".ytp-bezel"
] as const;

if (!state.listenerRegistered) {
  chrome.runtime.onMessage.addListener((message: ProbeMessage, _sender, sendResponse) => {
    if (message.type === "GET_VIDEO_SOURCE_INFO") {
      sendResponse(readVideoSourceInfo());
      return false;
    }

    if (message.type === "START_VIDEO_PROBE") {
      startProbe(message.sessionId, message.tabId, message.sampleIntervalMs);
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === "STOP_VIDEO_PROBE") {
      stopProbe(message.sessionId);
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });
  state.listenerRegistered = true;
}

function startProbe(sessionId: string, tabId: number, sampleIntervalMs: number): void {
  stopCurrentProbe();
  state.sessionId = sessionId;
  state.tabId = tabId;
  suppressPlayerOverlays();
  sendTick();
  state.intervalId = window.setInterval(sendTick, sampleIntervalMs);
}

function stopProbe(sessionId: string): void {
  if (state.sessionId && state.sessionId !== sessionId) {
    return;
  }

  stopCurrentProbe();
}

function stopCurrentProbe(): void {
  if (state.intervalId !== null) {
    window.clearInterval(state.intervalId);
  }

  state.intervalId = null;
  state.sessionId = null;
  state.tabId = null;
  restorePlayerOverlays();
}

function suppressPlayerOverlays(): void {
  restorePlayerOverlays();
  const style = document.createElement("style");
  style.id = PLAYER_OVERLAY_STYLE_ID;
  style.textContent = `${PLAYER_OVERLAY_SELECTORS.join(",\n")} {
    visibility: hidden !important;
    opacity: 0 !important;
    pointer-events: none !important;
  }`;
  (document.head ?? document.documentElement).append(style);
}

function restorePlayerOverlays(): void {
  document.getElementById(PLAYER_OVERLAY_STYLE_ID)?.remove();
}

function sendTick(): void {
  const video = findVideo();

  if (!video || !state.sessionId || state.tabId === null) {
    return;
  }

  const videoId = parseYouTubeVideoId(location.href);

  if (!videoId) {
    return;
  }

  const durationSec = Number.isFinite(video.duration) ? video.duration : null;
  void chrome.runtime.sendMessage({
    type: "VIDEO_PROBE_TICK",
    sessionId: state.sessionId,
    tabId: state.tabId,
    videoId,
    currentTimeSec: video.currentTime,
    durationSec,
    paused: video.paused,
    playbackRate: video.playbackRate,
    videoRect: readVideoRect(video),
    viewport: readViewport(),
    wallClockAt: new Date().toISOString()
  });

  if (video.ended || (durationSec !== null && video.currentTime >= durationSec)) {
    void chrome.runtime.sendMessage({
      type: "VIDEO_ENDED",
      sessionId: state.sessionId,
      tabId: state.tabId,
      videoId,
      wallClockAt: new Date().toISOString()
    });
    stopProbe(state.sessionId);
  }
}

function readVideoSourceInfo(): ProbeResponse {
  const videoId = parseYouTubeVideoId(location.href);

  if (!videoId) {
    return {
      ok: false,
      error: {
        code: "NOT_YOUTUBE_WATCH_PAGE",
        message: "Current page is not a YouTube watch URL."
      }
    };
  }

  const video = findVideo();

  if (!video) {
    return {
      ok: false,
      error: {
        code: "VIDEO_ELEMENT_NOT_FOUND",
        message: "Unable to find the YouTube video element."
      }
    };
  }

  return {
    ok: true,
    source: {
      platform: "youtube",
      url: location.href,
      videoId,
      title: document.title,
      durationSec: Number.isFinite(video.duration) ? video.duration : null,
      currentTimeSec: video.currentTime,
      playbackRate: video.playbackRate,
      paused: video.paused,
      videoRect: readVideoRect(video),
      viewport: readViewport()
    }
  };
}

function findVideo(): HTMLVideoElement | null {
  return document.querySelector("video");
}

function readVideoRect(video: HTMLVideoElement): VideoElementRect {
  const rect = video.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height
  };
}

function readViewport(): ViewportInfo {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio
  };
}

function parseYouTubeVideoId(url: string): string | null {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();

  if (host !== "youtube.com" && !host.endsWith(".youtube.com")) {
    return null;
  }

  if (parsed.pathname !== "/watch") {
    return null;
  }

  const id = parsed.searchParams.get("v");
  return id && /^[a-zA-Z0-9_-]{6,}$/.test(id) ? id : null;
}

export {};
