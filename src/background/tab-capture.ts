import { captureError } from "../shared/errors";

export async function getTabMediaStreamId(tabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      const lastError = chrome.runtime.lastError;

      if (lastError || !streamId) {
        reject(captureError("TAB_CAPTURE_DENIED", "Failed to get tab capture stream id.", lastError?.message));
        return;
      }

      resolve(streamId);
    });
  });
}
