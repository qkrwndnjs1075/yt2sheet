import type { PixelFrame } from "./score-image-cleanup";

export function hasLargeFilledOverlay(frame: PixelFrame): boolean {
  const pixelCount = frame.width * frame.height;
  const visited = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);

  for (let start = 0; start < pixelCount; start += 1) {
    if (visited[start] || !isFilledOverlayPixel(frame, start)) {
      continue;
    }

    let head = 0;
    let tail = 1;
    let componentSize = 0;
    let minX = frame.width;
    let maxX = 0;
    let minY = frame.height;
    let maxY = 0;
    queue[0] = start;
    visited[start] = 1;

    while (head < tail) {
      const index = queue[head] ?? 0;
      head += 1;
      componentSize += 1;
      const x = index % frame.width;
      const y = Math.floor(index / frame.width);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);

      for (const neighbor of [index - 1, index + 1, index - frame.width, index + frame.width]) {
        const neighborX = neighbor % frame.width;
        if (
          neighbor < 0 || neighbor >= pixelCount || visited[neighbor] ||
          Math.abs(neighborX - x) > 1 || !isFilledOverlayPixel(frame, neighbor)
        ) {
          continue;
        }
        visited[neighbor] = 1;
        queue[tail] = neighbor;
        tail += 1;
      }
    }

    const boxWidth = maxX - minX + 1;
    const boxHeight = maxY - minY + 1;
    const fillRatio = componentSize / Math.max(1, boxWidth * boxHeight);
    if (
      componentSize / Math.max(1, pixelCount) >= 0.025 && fillRatio >= 0.55 &&
      boxWidth / Math.max(1, frame.width) >= 0.08 && boxHeight / Math.max(1, frame.height) >= 0.08
    ) {
      return true;
    }
  }
  return false;
}

function isFilledOverlayPixel(frame: PixelFrame, index: number): boolean {
  if (!isOverlayPixel(frame, index)) {
    return false;
  }
  const x = index % frame.width;
  const neighbors = [
    x > 0 ? index - 1 : -1,
    x + 1 < frame.width ? index + 1 : -1,
    index - frame.width,
    index + frame.width
  ];
  return neighbors.filter((neighbor) => neighbor >= 0 && neighbor < frame.width * frame.height && isOverlayPixel(frame, neighbor)).length >= 3;
}

function isOverlayPixel(frame: PixelFrame, index: number): boolean {
  const offset = index * 4;
  const red = frame.data[offset] ?? 255;
  const green = frame.data[offset + 1] ?? 255;
  const blue = frame.data[offset + 2] ?? 255;
  const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
  const value = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return value < 110 || (chroma > 55 && value < 245);
}
