import { isForeground } from "./score-image-pixels";

const STAFF_ROW_MIN_RATIO = 0.35;
const STAFF_CONTEXT_GAP_MULTIPLIER = 3;
const STAFF_CONTEXT_SLICES = 8;
const EDGE_MAX_WIDTH_RATIO = 0.02;

type RawImageInfo = { readonly width: number; readonly height: number; readonly channels: number };

export function cleanScoreImageArtifacts(data: Buffer, info: RawImageInfo): void {
  whitenNarrowEdgeComponents(data, info);
  whitenDetachedBottomInk(data, info);
}

function whitenNarrowEdgeComponents(data: Buffer, info: RawImageInfo): void {
  const maximumRunWidth = Math.max(2, Math.floor(info.width * EDGE_MAX_WIDTH_RATIO));
  const pixelCount = info.width * info.height;
  const visited = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  for (let y = 0; y < info.height; y += 1) {
    for (const x of [0, info.width - 1]) {
      const start = y * info.width + x;
      if (visited[start] === 1 || !isForeground(data, start, info.channels)) {
        continue;
      }
      let head = 0;
      let tail = 1;
      let minX = x;
      let maxX = x;
      queue[0] = start;
      visited[start] = 1;
      while (head < tail) {
        const pixel = queue[head];
        head += 1;
        const pixelX = pixel % info.width;
        const pixelY = Math.floor(pixel / info.width);
        minX = Math.min(minX, pixelX);
        maxX = Math.max(maxX, pixelX);
        for (const neighbor of [
          pixelX > 0 ? pixel - 1 : -1,
          pixelX + 1 < info.width ? pixel + 1 : -1,
          pixelY > 0 ? pixel - info.width : -1,
          pixelY + 1 < info.height ? pixel + info.width : -1
        ]) {
          if (neighbor >= 0 && visited[neighbor] === 0 && isForeground(data, neighbor, info.channels)) {
            visited[neighbor] = 1;
            queue[tail] = neighbor;
            tail += 1;
          }
        }
      }
      if (maxX - minX + 1 > maximumRunWidth) {
        continue;
      }
      for (let index = 0; index < tail; index += 1) {
        const offset = queue[index] * info.channels;
        data[offset] = 255;
        data[offset + 1] = 255;
        data[offset + 2] = 255;
      }
    }
  }
}

function whitenDetachedBottomInk(data: Buffer, info: RawImageInfo): void {
  const rowInkCounts = Array.from({ length: info.height }, () => 0);
  for (let pixel = 0; pixel < info.width * info.height; pixel += 1) {
    if (isForeground(data, pixel, info.channels)) {
      rowInkCounts[Math.floor(pixel / info.width)] += 1;
    }
  }

  const staffBands: Array<{ readonly center: number; readonly bottom: number }> = [];
  let runStart = -1;
  for (let row = 0; row <= info.height; row += 1) {
    if ((rowInkCounts[row] ?? 0) / info.width >= STAFF_ROW_MIN_RATIO) {
      runStart = runStart < 0 ? row : runStart;
      continue;
    }
    if (runStart >= 0) {
      staffBands.push({ center: Math.floor((runStart + row - 1) / 2), bottom: row - 1 });
      runStart = -1;
    }
  }
  if (staffBands.length < 5) {
    return;
  }

  const staffGaps = staffBands.slice(1).map((band, index) => band.center - staffBands[index].center).filter((gap) => gap >= 2);
  const staffGap = Math.min(...staffGaps);
  const lastStaff = staffBands[staffBands.length - 1];
  const maximumBlankRows = Math.max(12, Math.round(staffGap * STAFF_CONTEXT_GAP_MULTIPLIER));
  const sliceWidth = Math.ceil(info.width / STAFF_CONTEXT_SLICES);

  for (let slice = 0; slice < STAFF_CONTEXT_SLICES; slice += 1) {
    const left = slice * sliceWidth;
    const right = Math.min(info.width, left + sliceWidth);
    let lastContentRow = lastStaff.bottom;
    let blankRows = 0;
    for (let row = lastStaff.bottom + 1; row < info.height; row += 1) {
      let inkPixels = 0;
      for (let x = left; x < right; x += 1) {
        if (isForeground(data, row * info.width + x, info.channels)) {
          inkPixels += 1;
        }
      }
      if (inkPixels >= 2) {
        lastContentRow = row;
        blankRows = 0;
        continue;
      }
      blankRows += 1;
      if (blankRows < maximumBlankRows) {
        continue;
      }
      for (let eraseRow = lastContentRow + 1; eraseRow < info.height; eraseRow += 1) {
        data.fill(255, (eraseRow * info.width + left) * info.channels, (eraseRow * info.width + right) * info.channels);
      }
      break;
    }
  }
}
