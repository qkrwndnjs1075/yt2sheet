import { captureError } from "../shared/errors";

const OFFSCREEN_DOCUMENT_PATH = "src/offscreen/offscreen.html";

let creating: Promise<void> | null = null;

export class OffscreenManager {
  async ensureDocument(): Promise<void> {
    const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [offscreenUrl]
    });

    if (existingContexts.length > 0) {
      return;
    }

    try {
      creating ??= chrome.offscreen.createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: [chrome.offscreen.Reason.USER_MEDIA],
        justification: "Capture tab video frames locally for timestamped score analysis input."
      });
      await creating;
    } catch (error) {
      throw captureError("OFFSCREEN_CREATE_FAILED", "Failed to create offscreen capture document.", error);
    } finally {
      creating = null;
    }
  }

  async closeDocument(): Promise<void> {
    const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [offscreenUrl]
    });

    if (existingContexts.length === 0) {
      return;
    }

    try {
      await chrome.offscreen.closeDocument();
    } catch (error) {
      if (isNoCurrentOffscreenDocumentError(error)) {
        return;
      }

      throw error;
    }
  }
}

function isNoCurrentOffscreenDocumentError(error: unknown): boolean {
  return error instanceof Error && /No current offscreen document/i.test(error.message);
}
