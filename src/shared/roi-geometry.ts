import type { Rect } from "./layout-types";
import type { VideoElementRect, ViewportInfo } from "./types";

export function viewportRectToFrameRect(input: {
  selectionRect: VideoElementRect;
  videoRect: VideoElementRect;
  frameSize: { width: number; height: number };
}): Rect {
  const contentRect = videoContentRect(input.videoRect, input.frameSize);
  const scaleX = input.frameSize.width / Math.max(1, contentRect.width);
  const scaleY = input.frameSize.height / Math.max(1, contentRect.height);
  const left = clamp(input.selectionRect.left, contentRect.left, contentRect.left + contentRect.width);
  const top = clamp(input.selectionRect.top, contentRect.top, contentRect.top + contentRect.height);
  const right = clamp(input.selectionRect.left + input.selectionRect.width, contentRect.left, contentRect.left + contentRect.width);
  const bottom = clamp(input.selectionRect.top + input.selectionRect.height, contentRect.top, contentRect.top + contentRect.height);

  return {
    x: Math.round((left - contentRect.left) * scaleX),
    y: Math.round((top - contentRect.top) * scaleY),
    width: Math.max(1, Math.round((right - left) * scaleX)),
    height: Math.max(1, Math.round((bottom - top) * scaleY))
  };
}

export function videoContentRect(videoRect: VideoElementRect, frameSize: { width: number; height: number }): VideoElementRect {
  // HTMLVideoElement uses centered object-fit: contain by default; trim letterbox/pillarbox bars before mapping manual ROI coordinates.
  const frameAspect = Math.max(1, frameSize.width) / Math.max(1, frameSize.height);
  const elementAspect = Math.max(1, videoRect.width) / Math.max(1, videoRect.height);

  if (Math.abs(frameAspect - elementAspect) < 0.001) {
    return videoRect;
  }

  if (elementAspect > frameAspect) {
    const width = videoRect.height * frameAspect;
    return {
      left: videoRect.left + (videoRect.width - width) / 2,
      top: videoRect.top,
      width,
      height: videoRect.height
    };
  }

  const height = videoRect.width / frameAspect;
  return {
    left: videoRect.left,
    top: videoRect.top + (videoRect.height - height) / 2,
    width: videoRect.width,
    height
  };
}

export function frameRectToViewportRect(input: {
  frameRect: Rect;
  videoRect: VideoElementRect;
  frameSize: { width: number; height: number };
}): VideoElementRect {
  const contentRect = videoContentRect(input.videoRect, input.frameSize);
  const scaleX = contentRect.width / Math.max(1, input.frameSize.width);
  const scaleY = contentRect.height / Math.max(1, input.frameSize.height);

  return {
    left: contentRect.left + input.frameRect.x * scaleX,
    top: contentRect.top + input.frameRect.y * scaleY,
    width: input.frameRect.width * scaleX,
    height: input.frameRect.height * scaleY
  };
}

export function frameRectToCaptureBitmapRect(input: {
  frameRect: Rect;
  videoRect: VideoElementRect;
  frameSize: { width: number; height: number };
  viewport: ViewportInfo;
  bitmapSize: { width: number; height: number };
}): Rect {
  const viewportRect = frameRectToViewportRect(input);
  return viewportRectToCaptureBitmapRect({
    viewportRect,
    viewport: input.viewport,
    bitmapSize: input.bitmapSize
  });
}

export function viewportRectToCaptureBitmapRect(input: {
  viewportRect: VideoElementRect;
  viewport: ViewportInfo;
  bitmapSize: { width: number; height: number };
}): Rect {
  const viewportWidth = Math.max(1, input.viewport.width);
  const viewportHeight = Math.max(1, input.viewport.height);
  const scale = Math.min(input.bitmapSize.width / viewportWidth, input.bitmapSize.height / viewportHeight);
  const offsetX = (input.bitmapSize.width - viewportWidth * scale) / 2;
  const offsetY = (input.bitmapSize.height - viewportHeight * scale) / 2;

  return {
    x: offsetX + input.viewportRect.left * scale,
    y: offsetY + input.viewportRect.top * scale,
    width: input.viewportRect.width * scale,
    height: input.viewportRect.height * scale
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
