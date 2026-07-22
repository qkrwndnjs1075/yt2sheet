export type RoiViewportRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type RoiDragPoint = {
  x: number;
  y: number;
};

export type RoiDragState =
  | {
      mode: "draw";
      start: RoiDragPoint;
    }
  | {
      mode: "move";
      pointerOffset: RoiDragPoint;
      rect: RoiViewportRect;
    };

export function beginRoiDrag(point: RoiDragPoint, existingRect: RoiViewportRect | null, bounds: RoiViewportRect): RoiDragState {
  const start = clampPoint(point, bounds);
  const clampedExistingRect = existingRect ? clampDragRect(existingRect, bounds) : null;

  if (clampedExistingRect && containsPoint(clampedExistingRect, start)) {
    return {
      mode: "move",
      pointerOffset: {
        x: start.x - clampedExistingRect.left,
        y: start.y - clampedExistingRect.top
      },
      rect: clampedExistingRect
    };
  }

  return { mode: "draw", start };
}

export function updateRoiDrag(state: RoiDragState, point: RoiDragPoint, bounds: RoiViewportRect): RoiViewportRect {
  const current = clampPoint(point, bounds);

  if (state.mode === "move") {
    return clampMovedRect({
      left: current.x - state.pointerOffset.x,
      top: current.y - state.pointerOffset.y,
      width: state.rect.width,
      height: state.rect.height
    }, bounds);
  }

  return normalizeDragRect(state.start, current);
}

export function normalizeDragRect(start: RoiDragPoint, end: RoiDragPoint): RoiViewportRect {
  return {
    left: Math.min(start.x, end.x),
    top: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y)
  };
}

export function clampDragRect(rect: RoiViewportRect, bounds: RoiViewportRect): RoiViewportRect {
  const left = Math.max(bounds.left, Math.min(bounds.left + bounds.width, rect.left));
  const top = Math.max(bounds.top, Math.min(bounds.top + bounds.height, rect.top));
  const right = Math.max(left, Math.min(bounds.left + bounds.width, rect.left + rect.width));
  const bottom = Math.max(top, Math.min(bounds.top + bounds.height, rect.top + rect.height));
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top)
  };
}

export function clampPoint(point: RoiDragPoint, bounds: RoiViewportRect): RoiDragPoint {
  return {
    x: Math.max(bounds.left, Math.min(bounds.left + bounds.width, point.x)),
    y: Math.max(bounds.top, Math.min(bounds.top + bounds.height, point.y))
  };
}

function containsPoint(rect: RoiViewportRect, point: RoiDragPoint): boolean {
  return point.x >= rect.left && point.x <= rect.left + rect.width && point.y >= rect.top && point.y <= rect.top + rect.height;
}

function clampMovedRect(rect: RoiViewportRect, bounds: RoiViewportRect): RoiViewportRect {
  const width = Math.min(Math.max(1, rect.width), Math.max(1, bounds.width));
  const height = Math.min(Math.max(1, rect.height), Math.max(1, bounds.height));
  const left = Math.max(bounds.left, Math.min(bounds.left + bounds.width - width, rect.left));
  const top = Math.max(bounds.top, Math.min(bounds.top + bounds.height - height, rect.top));

  return { left, top, width, height };
}
