import { logger } from "../shared/logger";
import { captureError } from "../shared/errors";
import type { CaptureCommandResponse, RuntimeMessage } from "../shared/messages";
import { DebugFrameSink } from "./debug-frame-sink";
import { FrameInputCollector } from "./frame-input-collector";

const collector = new FrameInputCollector();
collector.setFrameSink(new DebugFrameSink());

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse: (response: CaptureCommandResponse) => void) => {
  if (message.type === "START_CAPTURE" || message.type === "STOP_CAPTURE") {
    void handleCommandMessage(message).then(sendResponse);
    return true;
  }

  if (message.type === "VIDEO_TIMING_UPDATE") {
    collector.updateTiming(message.tick);
  }

  return false;
});

async function handleCommandMessage(message: Extract<RuntimeMessage, { type: "START_CAPTURE" | "STOP_CAPTURE" }>): Promise<CaptureCommandResponse> {
  try {
    if (message.type === "START_CAPTURE") {
      await collector.start(message.session, message.streamId);
      return { ok: true };
    }

    await collector.stop(message.reason);
    return { ok: true };
  } catch (error) {
    logger.error("Offscreen command failed", error);
    return {
      ok: false,
      error: captureError("GET_USER_MEDIA_FAILED", "Offscreen capture command failed.", error, message.type === "START_CAPTURE" ? message.session.id : message.sessionId)
    };
  }
}
