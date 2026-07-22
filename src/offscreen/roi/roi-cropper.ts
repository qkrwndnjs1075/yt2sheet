import type { Rect } from "../../shared/layout-types";
import { frameRectToCaptureBitmapRect } from "../../shared/roi-geometry";
import type { ScoreRoiConfig } from "../../shared/roi-types";
import type { OffscreenInputFrame } from "../frame-sink";

export class RoiCropper {
  crop(frame: OffscreenInputFrame, configOrRect: ScoreRoiConfig | Rect): HTMLCanvasElement {
    const sourceRect = clampRect(sourceRectFor(frame, configOrRect), frame.image.width, frame.image.height);
    const canvas = document.createElement("canvas");
    canvas.width = sourceRect.width;
    canvas.height = sourceRect.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });

    if (!context) {
      throw new Error("Unable to create ROI crop canvas context.");
    }

    context.drawImage(
      frame.image.bitmapRef,
      sourceRect.x,
      sourceRect.y,
      sourceRect.width,
      sourceRect.height,
      0,
      0,
      sourceRect.width,
      sourceRect.height
    );
    return canvas;
  }
}

function sourceRectFor(frame: OffscreenInputFrame, configOrRect: ScoreRoiConfig | Rect): Rect {
  if (!("roiRect" in configOrRect)) {
    return configOrRect;
  }

  const { roiRect, frameSize } = configOrRect;
  const { videoRect, viewport } = frame.meta;

  if (!frameSize || !videoRect || !viewport) {
    return roiRect;
  }

  return frameRectToCaptureBitmapRect({
    frameRect: roiRect,
    videoRect,
    frameSize,
    viewport,
    bitmapSize: {
      width: frame.image.width,
      height: frame.image.height
    }
  });
}

function clampRect(rect: Rect, width: number, height: number): Rect {
  const x = Math.max(0, Math.min(width - 1, Math.round(rect.x)));
  const y = Math.max(0, Math.min(height - 1, Math.round(rect.y)));
  const right = Math.max(x + 1, Math.min(width, Math.round(rect.x + rect.width)));
  const bottom = Math.max(y + 1, Math.min(height, Math.round(rect.y + rect.height)));
  return {
    x,
    y,
    width: right - x,
    height: bottom - y
  };
}
