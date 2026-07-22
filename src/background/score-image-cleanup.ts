export type PixelFrame = {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
};

export type ScoreCrop = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type ScorePixelCleanup = {
  readonly frame: PixelFrame;
  readonly crop: ScoreCrop;
  readonly repairedPixelCount: number;
};

const BACKGROUND_PIXEL_MIN = 225;
const MIN_CONTENT_RATIO = 0.002;
const SOLID_EDGE_RATIO = 0.6;
const SOLID_SEPARATOR_RATIO = 0.9;
const MIN_SEPARATOR_ROWS = 3;

export function cleanScorePixels(primary: PixelFrame, alternatives: readonly PixelFrame[]): ScorePixelCleanup {
  const compatible = alternatives.filter((frame) => frame.width === primary.width && frame.height === primary.height);
  const frames = [primary, ...compatible];
  const output = new Uint8ClampedArray(primary.data);
  let repairedPixelCount = 0;

  if (frames.length >= 3) {
    const backgroundQuorum = Math.floor(frames.length / 2) + 1;
    for (let offset = 0; offset < output.length; offset += 4) {
      const primaryRed = primary.data[offset] ?? 255;
      const primaryGreen = primary.data[offset + 1] ?? 255;
      const primaryBlue = primary.data[offset + 2] ?? 255;
      const primaryLuminance = luminance(primaryRed, primaryGreen, primaryBlue);
      if (isPaperLike(primaryRed, primaryGreen, primaryBlue)) {
        continue;
      }

      let backgroundCount = 0;
      let bestFrame = primary;
      let bestLuminance = primaryLuminance;
      for (const frame of frames) {
        const red = frame.data[offset] ?? 255;
        const green = frame.data[offset + 1] ?? 255;
        const blue = frame.data[offset + 2] ?? 255;
        const value = luminance(red, green, blue);
        if (isPaperLike(red, green, blue)) {
          backgroundCount += 1;
          if (value > bestLuminance) {
            bestFrame = frame;
            bestLuminance = value;
          }
        }
      }
      if (backgroundCount < backgroundQuorum) {
        continue;
      }

      output[offset] = bestFrame.data[offset] ?? 255;
      output[offset + 1] = bestFrame.data[offset + 1] ?? 255;
      output[offset + 2] = bestFrame.data[offset + 2] ?? 255;
      output[offset + 3] = bestFrame.data[offset + 3] ?? 255;
      repairedPixelCount += 1;
    }
  }

  const frame = { width: primary.width, height: primary.height, data: output };
  const separatorRows = findSeparatorBandRows(measureRowInkRatios(frame));
  for (let offset = 0; offset < output.length; offset += 4) {
    const row = Math.floor(offset / 4 / primary.width);
    const red = output[offset] ?? 255;
    const green = output[offset + 1] ?? 255;
    const blue = output[offset + 2] ?? 255;
    const alpha = output[offset + 3] ?? 255;
    if (!separatorRows.has(row) && !isPaperLike(red, green, blue)) {
      continue;
    }
    if (red === 255 && green === 255 && blue === 255 && alpha === 255) {
      continue;
    }
    output[offset] = 255;
    output[offset + 1] = 255;
    output[offset + 2] = 255;
    output[offset + 3] = 255;
    repairedPixelCount += 1;
  }
  return { frame, crop: findSafeScoreCrop(frame), repairedPixelCount };
}

export function findSafeScoreCrop(frame: PixelFrame): ScoreCrop {
  const rowInkRatios = measureRowInkRatios(frame);
  if (!hasPlausibleStaffRows(rowInkRatios)) {
    return fullFrameCrop(frame);
  }
  const solidRows = findSolidBandRows(rowInkRatios);
  let firstContentRow = -1;
  let lastContentRow = -1;

  for (let row = 0; row < frame.height; row += 1) {
    if (!solidRows.has(row) && (rowInkRatios[row] ?? 0) >= MIN_CONTENT_RATIO) {
      firstContentRow = firstContentRow < 0 ? row : firstContentRow;
      lastContentRow = row;
    }
  }

  if (firstContentRow < 0 || lastContentRow < firstContentRow) {
    return fullFrameCrop(frame);
  }

  const padding = Math.min(24, Math.max(3, Math.round(frame.height * 0.04)));
  let contentTopBoundary = 0;
  let contentBottomBoundary = frame.height;
  for (const row of solidRows) {
    if (row < firstContentRow) {
      contentTopBoundary = Math.max(contentTopBoundary, row + 1);
    } else if (row > lastContentRow) {
      contentBottomBoundary = Math.min(contentBottomBoundary, row);
    }
  }
  const top = Math.max(contentTopBoundary, firstContentRow - padding);
  const bottom = Math.min(contentBottomBoundary, lastContentRow + padding + 1);
  if ((bottom - top) / Math.max(1, frame.height) < 0.3) {
    return fullFrameCrop(frame);
  }

  return { x: 0, y: top, width: frame.width, height: bottom - top };
}

function hasPlausibleStaffRows(rowInkRatios: readonly number[]): boolean {
  const centers: number[] = [];
  let runStart = -1;
  for (let row = 0; row <= rowInkRatios.length; row += 1) {
    const ratio = rowInkRatios[row] ?? 0;
    if (ratio >= 0.2 && ratio < 0.96) {
      runStart = runStart < 0 ? row : runStart;
      continue;
    }
    if (runStart >= 0 && row - runStart <= 3) {
      centers.push((runStart + row - 1) / 2);
    }
    runStart = -1;
  }

  for (let index = 0; index + 2 < centers.length; index += 1) {
    const firstGap = (centers[index + 1] ?? 0) - (centers[index] ?? 0);
    const secondGap = (centers[index + 2] ?? 0) - (centers[index + 1] ?? 0);
    if (firstGap >= 1 && Math.abs(firstGap - secondGap) <= Math.max(1, firstGap * 0.35)) {
      return true;
    }
  }
  return false;
}

export function cropPixelFrame(frame: PixelFrame, crop: ScoreCrop): PixelFrame {
  if (crop.x === 0 && crop.y === 0 && crop.width === frame.width && crop.height === frame.height) {
    return frame;
  }

  const data = new Uint8ClampedArray(crop.width * crop.height * 4);
  for (let row = 0; row < crop.height; row += 1) {
    const sourceOffset = ((crop.y + row) * frame.width + crop.x) * 4;
    const targetOffset = row * crop.width * 4;
    data.set(frame.data.subarray(sourceOffset, sourceOffset + crop.width * 4), targetOffset);
  }
  return { width: crop.width, height: crop.height, data };
}

function measureRowInkRatios(frame: PixelFrame): number[] {
  const ratios: number[] = [];
  for (let row = 0; row < frame.height; row += 1) {
    let inkPixels = 0;
    for (let column = 0; column < frame.width; column += 1) {
      const offset = (row * frame.width + column) * 4;
      const red = frame.data[offset] ?? 255;
      const green = frame.data[offset + 1] ?? 255;
      const blue = frame.data[offset + 2] ?? 255;
      if (!isPaperLike(red, green, blue)) {
        inkPixels += 1;
      }
    }
    ratios.push(inkPixels / Math.max(1, frame.width));
  }
  return ratios;
}

function findSolidBandRows(rowInkRatios: readonly number[]): Set<number> {
  const rows = new Set<number>();
  const minimumBandRows = Math.max(3, Math.round(rowInkRatios.length * 0.025));
  const edgeAllowance = Math.max(3, Math.round(rowInkRatios.length * 0.03));
  let runStart = -1;

  for (let row = 0; row <= rowInkRatios.length; row += 1) {
    if ((rowInkRatios[row] ?? 0) >= SOLID_EDGE_RATIO) {
      runStart = runStart < 0 ? row : runStart;
      continue;
    }

    if (runStart >= 0) {
      const runLength = row - runStart;
      const touchesEdge = runStart <= edgeAllowance || rowInkRatios.length - row <= edgeAllowance;
      if (runLength >= minimumBandRows && touchesEdge) {
        for (let bandRow = runStart; bandRow < row; bandRow += 1) {
          rows.add(bandRow);
        }
      }
    }
    runStart = -1;
  }
  return rows;
}

function findSeparatorBandRows(rowInkRatios: readonly number[]): Set<number> {
  const rows = new Set<number>();
  let runStart = -1;

  for (let row = 0; row <= rowInkRatios.length; row += 1) {
    if ((rowInkRatios[row] ?? 0) >= SOLID_SEPARATOR_RATIO) {
      runStart = runStart < 0 ? row : runStart;
      continue;
    }
    if (runStart >= 0 && row - runStart >= MIN_SEPARATOR_ROWS) {
      for (let bandRow = runStart; bandRow < row; bandRow += 1) {
        rows.add(bandRow);
      }
    }
    runStart = -1;
  }
  return rows;
}

function fullFrameCrop(frame: PixelFrame): ScoreCrop {
  return { x: 0, y: 0, width: frame.width, height: frame.height };
}

function luminance(red: number, green: number, blue: number): number {
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function isPaperLike(red: number, green: number, blue: number): boolean {
  const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
  return luminance(red, green, blue) >= BACKGROUND_PIXEL_MIN && chroma <= 24;
}
