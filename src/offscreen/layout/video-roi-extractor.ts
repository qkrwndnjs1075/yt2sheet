import { clamp } from "../../shared/geometry";
import type { Rect } from "../../shared/layout-types";
import type { OffscreenInputFrame } from "../frame-sink";

export function extractVideoRoi(frame: OffscreenInputFrame): Rect {
  const rect = frame.meta.videoRect;
  const viewport = frame.meta.viewport;

  if (!rect || !viewport || viewport.width <= 0 || viewport.height <= 0 || rect.width <= 0 || rect.height <= 0) {
    return fullFrame(frame);
  }

  const scaleX = frame.image.width / viewport.width;
  const scaleY = frame.image.height / viewport.height;

  return clipRect(
    {
      x: rect.left * scaleX,
      y: rect.top * scaleY,
      width: rect.width * scaleX,
      height: rect.height * scaleY
    },
    frame.image.width,
    frame.image.height
  );
}

function fullFrame(frame: OffscreenInputFrame): Rect {
  return { x: 0, y: 0, width: frame.image.width, height: frame.image.height };
}

function clipRect(rect: Rect, width: number, height: number): Rect {
  const x = clamp(rect.x, 0, width);
  const y = clamp(rect.y, 0, height);
  const right = clamp(rect.x + rect.width, 0, width);
  const bottom = clamp(rect.y + rect.height, 0, height);

  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y)
  };
}
