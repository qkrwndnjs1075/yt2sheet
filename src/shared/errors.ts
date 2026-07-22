import type { CaptureError, CaptureErrorCode } from "./types";

export function captureError(code: CaptureErrorCode, message: string, cause?: unknown, sessionId?: string): CaptureError {
  return {
    code,
    message,
    sessionId,
    cause: causeMessage(cause)
  };
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (isCaptureErrorLike(error)) {
    const details = [error.cause ? `cause: ${error.cause}` : undefined, error.sessionId ? `session: ${error.sessionId}` : undefined]
      .filter(Boolean)
      .join(", ");
    return `${error.code}: ${error.message}${details ? ` (${details})` : ""}`;
  }

  if (isMessageLike(error)) {
    return error.name ? `${error.name}: ${error.message}` : error.message;
  }

  return String(error);
}

function causeMessage(cause: unknown): string | undefined {
  if (cause instanceof Error) {
    return cause.message;
  }

  if (typeof cause === "string") {
    return cause;
  }

  if (isMessageLike(cause)) {
    return cause.name ? `${cause.name}: ${cause.message}` : cause.message;
  }

  return undefined;
}

function isCaptureErrorLike(error: unknown): error is CaptureError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  );
}

function isMessageLike(error: unknown): error is { message: string; name?: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string" &&
    (!("name" in error) || typeof (error as { name?: unknown }).name === "string")
  );
}
