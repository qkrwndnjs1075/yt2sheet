import type { CaptureError, CaptureSession, InputFrame } from "../shared/types";

export type OffscreenInputFrame = InputFrame & {
  image: InputFrame["image"] & {
    bitmapRef: HTMLCanvasElement | OffscreenCanvas | ImageBitmap;
  };
};

export interface FrameSink {
  onFrame(frame: OffscreenInputFrame): void | Promise<void>;
  onSessionStarted(session: CaptureSession): void | Promise<void>;
  onSessionStopped(session: CaptureSession): void | Promise<void>;
  onError(error: CaptureError): void | Promise<void>;
}
