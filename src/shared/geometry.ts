import type { Rect } from "./layout-types";

export function area(rect: Rect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

export function unionRects(rects: Rect[]): Rect {
  if (rects.length === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));

  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function expandRect(rect: Rect, padding: number, bounds?: { width: number; height: number }): Rect {
  const x = Math.max(0, rect.x - padding);
  const y = Math.max(0, rect.y - padding);
  const right = rect.x + rect.width + padding;
  const bottom = rect.y + rect.height + padding;

  return {
    x,
    y,
    width: Math.max(0, (bounds ? Math.min(bounds.width, right) : right) - x),
    height: Math.max(0, (bounds ? Math.min(bounds.height, bottom) : bottom) - y)
  };
}

export function intersectionOverUnion(a: Rect, b: Rect): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const intersection = area({ x: left, y: top, width: right - left, height: bottom - top });
  const combined = area(a) + area(b) - intersection;

  return combined <= 0 ? 0 : intersection / combined;
}

export function lerpRect(a: Rect, b: Rect, amount: number): Rect {
  return {
    x: lerp(a.x, b.x, amount),
    y: lerp(a.y, b.y, amount),
    width: lerp(a.width, b.width, amount),
    height: lerp(a.height, b.height, amount)
  };
}

export function rectCenterDistance(a: Rect, b: Rect): number {
  const ax = a.x + a.width / 2;
  const ay = a.y + a.height / 2;
  const bx = b.x + b.width / 2;
  const by = b.y + b.height / 2;
  return Math.hypot(ax - bx, ay - by);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function scoreFromDistance(value: number, maxGood: number): number {
  if (maxGood <= 0) {
    return value === 0 ? 1 : 0;
  }

  return clamp(1 - value / maxGood, 0, 1);
}

export function median(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function lerp(a: number, b: number, amount: number): number {
  return a + (b - a) * amount;
}
