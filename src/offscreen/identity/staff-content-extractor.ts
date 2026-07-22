import type { NormalizedScoreImage } from "../../shared/fingerprint-types";

export type PixelRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const DARK_THRESHOLD = 150;
const MIN_STAFF_ROW_RUN_RATIO = 0.22;
const MIN_CONTENT_RETAIN_RATIO = 0.08;

export function extractStaffContent(image: NormalizedScoreImage): NormalizedScoreImage {
  const rect = findStaffContentRect(image.width, image.height, (x, y) => image.pixels[y * image.width + x] ?? 255);

  if (coversNearlyAllImage(rect, image.width, image.height)) {
    return image;
  }

  const pixels = new Uint8ClampedArray(rect.width * rect.height);
  for (let y = 0; y < rect.height; y += 1) {
    for (let x = 0; x < rect.width; x += 1) {
      pixels[y * rect.width + x] = image.pixels[(rect.y + y) * image.width + rect.x + x] ?? 255;
    }
  }

  return {
    width: rect.width,
    height: rect.height,
    pixels
  };
}

// Score-only heuristic: find the longest repeated horizontal staff-line runs and crop around them, leaving ROI geometry untouched.
export function findStaffContentRectInImageData(imageData: ImageData): PixelRect {
  return findStaffContentRect(imageData.width, imageData.height, (x, y) => {
    const offset = (y * imageData.width + x) * 4;
    const r = imageData.data[offset] ?? 255;
    const g = imageData.data[offset + 1] ?? 255;
    const b = imageData.data[offset + 2] ?? 255;
    return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  });
}

export function findStaffContentRect(width: number, height: number, pixelAt: (x: number, y: number) => number): PixelRect {
  const staffRows = detectStaffRowRuns(width, height, pixelAt);

  if (staffRows.length < 3) {
    return { x: 0, y: 0, width, height };
  }

  let left = width;
  let right = 0;

  for (const row of staffRows) {
    left = Math.min(left, row.startX);
    right = Math.max(right, row.endX);
  }

  if (right <= left || (right - left) / Math.max(1, width) < MIN_CONTENT_RETAIN_RATIO) {
    return { x: 0, y: 0, width, height };
  }

  const topStaff = staffRows[0]?.y ?? 0;
  const bottomStaff = staffRows[staffRows.length - 1]?.y ?? height - 1;
  const staffSpan = Math.max(1, bottomStaff - topStaff + 1);
  const xPadding = Math.max(4, Math.round(width * 0.025));
  const yPadding = Math.max(Math.round(height * 0.1), Math.round(staffSpan * 0.75));
  const x = Math.max(0, left - xPadding);
  const y = Math.max(0, topStaff - yPadding);
  const rectRight = Math.min(width, right + xPadding);
  const rectBottom = Math.min(height, bottomStaff + yPadding);

  return {
    x,
    y,
    width: Math.max(1, rectRight - x),
    height: Math.max(1, rectBottom - y)
  };
}

export function detectStaffRowRuns(width: number, height: number, pixelAt: (x: number, y: number) => number): Array<{ y: number; startX: number; endX: number }> {
  const rows: Array<{ y: number; startX: number; endX: number }> = [];
  const minRun = Math.max(12, Math.round(width * MIN_STAFF_ROW_RUN_RATIO));

  for (let y = 0; y < height; y += 1) {
    let run = 0;
    let maxRun = 0;
    let runStart = 0;
    let maxStart = 0;
    let maxEnd = 0;

    for (let x = 0; x < width; x += 1) {
      if (pixelAt(x, y) < DARK_THRESHOLD) {
        if (run === 0) {
          runStart = x;
        }
        run += 1;
        if (run > maxRun) {
          maxRun = run;
          maxStart = runStart;
          maxEnd = x + 1;
        }
      } else {
        run = 0;
      }
    }

    if (maxRun >= minRun) {
      rows.push({ y, startX: maxStart, endX: maxEnd });
    }
  }

  return rows.filter((row, index) => index === 0 || row.y - rows[index - 1].y > 1);
}

function coversNearlyAllImage(rect: PixelRect, width: number, height: number): boolean {
  return rect.x === 0 && rect.y === 0 && rect.width === width && rect.height === height;
}
