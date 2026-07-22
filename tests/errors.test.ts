import assert from "node:assert/strict";
import { test } from "node:test";
import { captureError, toErrorMessage } from "../src/shared/errors.js";

test("CaptureError objects format with code, message, cause, and session id", () => {
  const error = captureError("TAB_CAPTURE_DENIED", "Failed to get tab capture stream id.", "Extension has not been invoked.", "session-1");

  assert.equal(
    toErrorMessage(error),
    "TAB_CAPTURE_DENIED: Failed to get tab capture stream id. (cause: Extension has not been invoked., session: session-1)"
  );
});

test("DOMException-like objects format with name and message", () => {
  const error = { name: "NotReadableError", message: "Error starting tab capture" };

  assert.equal(toErrorMessage(error), "NotReadableError: Error starting tab capture");
  assert.equal(
    toErrorMessage(captureError("GET_USER_MEDIA_FAILED", "Offscreen capture command failed.", error, "session-1")),
    "GET_USER_MEDIA_FAILED: Offscreen capture command failed. (cause: NotReadableError: Error starting tab capture, session: session-1)"
  );
});
