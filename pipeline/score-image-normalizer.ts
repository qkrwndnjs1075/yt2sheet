import sharp from "sharp";
import { cleanScoreImageArtifacts } from "./score-image-artifact-cleanup";
import { isForeground } from "./score-image-pixels";

const PAPER_CHANNEL_MIN = 205;
const PAPER_CHROMA_MAX = 12;
const PHOTO_COMPONENT_RATIO = 0.003;
const PHOTO_COLOR_PIXELS_MIN = 64;
const PHOTO_BOUNDS_PADDING_RATIO = 0.12;
const NOTATION_IDENTITY_WIDTH = 96;
const NOTATION_IDENTITY_HEIGHT = 48;
const NOTATION_INK_THRESHOLD = 180;
const STAFF_ROW_INK_RATIO = 0.45;
const TRACKER_MIN_HEIGHT_RATIO = 0.8;
const TRACKER_MAX_WIDTH_RATIO = 0.02;
const MAX_NOTATION_TRANSLATION = 2;
const MIN_NOTATION_OVERLAP = 0.6;
const IDENTITY_LIGHT_ARTIFACT_CHANNEL_MIN = 180;
const PLAYBACK_MARKER_GREEN_MIN = 120;
const PLAYBACK_MARKER_BLUE_MIN = 140;
const PLAYBACK_MARKER_GREEN_EXCESS_MIN = 80;
const PLAYBACK_MARKER_BLUE_EXCESS_MIN = 100;

export type NotationIdentity = {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
  readonly staffGap: number | null;
};

export async function normalizeScoreImage(image: Buffer, verticalPadding = 0): Promise<Buffer> {
  const raw = await sharp(image).toColourspace("srgb").removeAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let index = 0; index < raw.data.length; index += raw.info.channels) {
    const red = raw.data[index];
    const green = raw.data[index + 1];
    const blue = raw.data[index + 2];
    const darkest = Math.min(red, green, blue);
    const chroma = Math.max(red, green, blue) - darkest;
    if (darkest >= PAPER_CHANNEL_MIN && chroma <= PAPER_CHROMA_MAX) {
      raw.data[index] = 255;
      raw.data[index + 1] = 255;
      raw.data[index + 2] = 255;
    }
  }
  removePhotographicComponents(raw.data, raw.info);
  cleanScoreImageArtifacts(raw.data, raw.info);
  const bounds = findVerticalInkBounds(raw.data, raw.info);
  const normalized = sharp(raw.data, { raw: raw.info });
  if (!bounds || verticalPadding <= 0) {
    return normalized.png().toBuffer();
  }
  const padding = Math.max(1, Math.round(verticalPadding));
  return normalized
    .extract({ left: 0, top: bounds.top, width: raw.info.width, height: bounds.bottom - bounds.top + 1 })
    .extend({ top: padding, bottom: padding, left: 0, right: 0, background: "white" })
    .png()
    .toBuffer();
}

export async function createDifferenceHash(image: Buffer): Promise<Uint8Array> {
  const pixels = await sharp(image).greyscale().resize(17, 8, { fit: "fill" }).raw().toBuffer();
  const hash = new Uint8Array(16);
  let bitIndex = 0;
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      if (pixels[y * 17 + x] > pixels[y * 17 + x + 1]) {
        hash[Math.floor(bitIndex / 8)] |= 1 << (7 - (bitIndex % 8));
      }
      bitIndex += 1;
    }
  }
  return hash;
}

export async function createDominantInkHash(image: Buffer): Promise<Uint8Array | null> {
  const raw = await sharp(image).greyscale().raw().toBuffer({ resolveWithObject: true });
  const bounds = findDominantInkBounds(raw.data, raw.info.width, raw.info.height);
  if (!bounds) return null;
  const dominantInk = await sharp(image).extract(bounds).png().toBuffer();
  return createDifferenceHash(dominantInk);
}

export async function createDeduplicationImage(image: Buffer): Promise<Buffer> {
  const raw = await sharp(image).toColourspace("srgb").removeAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let index = 0; index < raw.data.length; index += raw.info.channels) {
    if (!isDeduplicationArtifact(raw.data[index], raw.data[index + 1], raw.data[index + 2])) continue;
    raw.data[index] = 255;
    raw.data[index + 1] = 255;
    raw.data[index + 2] = 255;
  }
  return sharp(raw.data, { raw: raw.info }).png().toBuffer();
}

export async function createNotationIdentity(image: Buffer): Promise<NotationIdentity> {
  const raw = await sharp(image).greyscale().raw().toBuffer({ resolveWithObject: true });
  const staffRows = findStaffRows(raw.data, raw.info.width, raw.info.height);
  const trackerColumns = findTrackerColumns(raw.data, raw.info.width, raw.info.height);
  const staffBounds = findStaffVerticalBounds(staffRows);
  const sourceTop = staffBounds?.top ?? 0;
  const sourceHeight = staffBounds?.height ?? raw.info.height;
  const staffGap = findStaffGap(staffRows);
  const pixels = new Uint8Array(NOTATION_IDENTITY_WIDTH * NOTATION_IDENTITY_HEIGHT);

  for (let targetY = 0; targetY < NOTATION_IDENTITY_HEIGHT; targetY += 1) {
    const top = sourceTop + Math.floor(targetY * sourceHeight / NOTATION_IDENTITY_HEIGHT);
    const bottom = Math.max(top + 1, sourceTop + Math.floor((targetY + 1) * sourceHeight / NOTATION_IDENTITY_HEIGHT));
    for (let targetX = 0; targetX < NOTATION_IDENTITY_WIDTH; targetX += 1) {
      const left = Math.floor(targetX * raw.info.width / NOTATION_IDENTITY_WIDTH);
      const right = Math.max(left + 1, Math.floor((targetX + 1) * raw.info.width / NOTATION_IDENTITY_WIDTH));
      for (let y = top; y < bottom && pixels[targetY * NOTATION_IDENTITY_WIDTH + targetX] === 0; y += 1) {
        if (staffRows[y] === 1) continue;
        for (let x = left; x < right; x += 1) {
          if (trackerColumns[x] === 1) continue;
          if (raw.data[y * raw.info.width + x] < NOTATION_INK_THRESHOLD) {
            pixels[targetY * NOTATION_IDENTITY_WIDTH + targetX] = 1;
            break;
          }
        }
      }
    }
  }

  return { width: NOTATION_IDENTITY_WIDTH, height: NOTATION_IDENTITY_HEIGHT, pixels, staffGap };
}

export function hasStrongNotationOverlap(left: NotationIdentity, right: NotationIdentity): boolean {
  if (left.width !== right.width || left.height !== right.height) return false;
  for (let offsetY = -MAX_NOTATION_TRANSLATION; offsetY <= MAX_NOTATION_TRANSLATION; offsetY += 1) {
    const leftTop = Math.max(0, offsetY);
    const leftBottom = Math.min(left.height, left.height + offsetY);
    const rightTop = Math.max(0, -offsetY);
    for (let offsetX = -MAX_NOTATION_TRANSLATION; offsetX <= MAX_NOTATION_TRANSLATION; offsetX += 1) {
      const leftStart = Math.max(0, offsetX);
      const leftEnd = Math.min(left.width, left.width + offsetX);
      const rightStart = Math.max(0, -offsetX);
      let sharedInk = 0;
      let combinedInk = 0;
      for (let leftY = leftTop, rightY = rightTop; leftY < leftBottom; leftY += 1, rightY += 1) {
        for (let leftX = leftStart, rightX = rightStart; leftX < leftEnd; leftX += 1, rightX += 1) {
          const leftInk = left.pixels[leftY * left.width + leftX];
          const rightInk = right.pixels[rightY * right.width + rightX];
          if (leftInk === 1 || rightInk === 1) combinedInk += 1;
          if (leftInk === 1 && rightInk === 1) sharedInk += 1;
        }
      }
      if (combinedInk > 0 && sharedInk / combinedInk >= MIN_NOTATION_OVERLAP) return true;
    }
  }
  return false;
}

function removePhotographicComponents(
  data: Buffer,
  info: { readonly width: number; readonly height: number; readonly channels: number }
): void {
  const pixelCount = info.width * info.height;
  const visited = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  const minimumPixels = Math.max(256, Math.floor(pixelCount * PHOTO_COMPONENT_RATIO));

  for (let start = 0; start < pixelCount; start += 1) {
    if (visited[start] === 1 || !isForeground(data, start, info.channels)) {
      continue;
    }
    let head = 0;
    let tail = 1;
    let coloredPixels = 0;
    let minX = start % info.width;
    let maxX = minX;
    let minY = Math.floor(start / info.width);
    let maxY = minY;
    queue[0] = start;
    visited[start] = 1;

    while (head < tail) {
      const pixel = queue[head];
      head += 1;
      const x = pixel % info.width;
      const y = Math.floor(pixel / info.width);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      if (isColored(data, pixel, info.channels)) {
        coloredPixels += 1;
      }
      const neighbors = [
        x > 0 ? pixel - 1 : -1,
        x + 1 < info.width ? pixel + 1 : -1,
        y > 0 ? pixel - info.width : -1,
        y + 1 < info.height ? pixel + info.width : -1
      ];
      for (const neighbor of neighbors) {
        if (neighbor >= 0 && visited[neighbor] === 0 && isForeground(data, neighbor, info.channels)) {
          visited[neighbor] = 1;
          queue[tail] = neighbor;
          tail += 1;
        }
      }
    }

    const componentWidth = maxX - minX + 1;
    const componentHeight = maxY - minY + 1;
    const isCompact = componentWidth <= info.width * 0.3 && componentHeight <= info.height * 0.5;
    const isImageSized = componentWidth >= info.width * 0.04 && componentHeight >= info.height * 0.2;
    if (tail < minimumPixels || coloredPixels < PHOTO_COLOR_PIXELS_MIN || !isCompact || !isImageSized) {
      continue;
    }
    const padding = Math.ceil(Math.max(componentWidth, componentHeight) * PHOTO_BOUNDS_PADDING_RATIO);
    const eraseLeft = Math.max(0, minX - padding);
    const eraseRight = Math.min(info.width - 1, maxX + padding);
    const eraseTop = Math.max(0, minY - padding);
    const eraseBottom = Math.min(info.height - 1, maxY + padding);
    for (let y = eraseTop; y <= eraseBottom; y += 1) {
      for (let x = eraseLeft; x <= eraseRight; x += 1) {
        const offset = (y * info.width + x) * info.channels;
        data[offset] = 255;
        data[offset + 1] = 255;
        data[offset + 2] = 255;
      }
    }
  }
}

function isColored(data: Buffer, pixel: number, channels: number): boolean {
  const offset = pixel * channels;
  const red = data[offset];
  const green = data[offset + 1];
  const blue = data[offset + 2];
  return Math.max(red, green, blue) - Math.min(red, green, blue) > PAPER_CHROMA_MAX;
}

function isDeduplicationArtifact(red: number, green: number, blue: number): boolean {
  if (Math.min(red, green, blue) >= IDENTITY_LIGHT_ARTIFACT_CHANNEL_MIN) return true;
  return green >= PLAYBACK_MARKER_GREEN_MIN
    && blue >= PLAYBACK_MARKER_BLUE_MIN
    && green - red >= PLAYBACK_MARKER_GREEN_EXCESS_MIN
    && blue - red >= PLAYBACK_MARKER_BLUE_EXCESS_MIN;
}

function findStaffRows(data: Buffer, width: number, height: number): Uint8Array {
  const rows = new Uint8Array(height);
  for (let y = 0; y < height; y += 1) {
    let ink = 0;
    for (let x = 0; x < width; x += 1) {
      if (data[y * width + x] < NOTATION_INK_THRESHOLD) ink += 1;
    }
    if (ink < width * STAFF_ROW_INK_RATIO) continue;
    rows[Math.max(0, y - 1)] = 1;
    rows[y] = 1;
    rows[Math.min(height - 1, y + 1)] = 1;
  }
  return rows;
}

function findStaffVerticalBounds(rows: Uint8Array): { readonly top: number; readonly height: number } | null {
  let top = rows.length;
  let bottom = -1;
  for (let row = 0; row < rows.length; row += 1) {
    if (rows[row] !== 1) continue;
    top = Math.min(top, row);
    bottom = row;
  }
  return bottom < top ? null : { top, height: bottom - top + 1 };
}

function findStaffGap(rows: Uint8Array): number | null {
  const centers: number[] = [];
  for (let start = 0; start < rows.length;) {
    if (rows[start] !== 1) {
      start += 1;
      continue;
    }
    let end = start + 1;
    while (end < rows.length && rows[end] === 1) end += 1;
    centers.push((start + end - 1) / 2);
    start = end;
  }
  const gaps = centers.slice(1).map((center, index) => center - centers[index]).filter((gap) => gap >= 2).sort((left, right) => left - right);
  if (gaps.length === 0) return null;
  return gaps[Math.floor(gaps.length / 2)];
}

function findTrackerColumns(data: Buffer, width: number, height: number): Uint8Array {
  const columns = new Uint8Array(width);
  const maximumWidth = Math.max(2, Math.floor(width * TRACKER_MAX_WIDTH_RATIO));
  for (let start = 0; start < width;) {
    let darkPixels = 0;
    for (let y = 0; y < height; y += 1) {
      if (data[y * width + start] < NOTATION_INK_THRESHOLD) darkPixels += 1;
    }
    if (darkPixels / height < TRACKER_MIN_HEIGHT_RATIO) {
      start += 1;
      continue;
    }
    let end = start + 1;
    while (end < width) {
      let adjacentDarkPixels = 0;
      for (let y = 0; y < height; y += 1) {
        if (data[y * width + end] < NOTATION_INK_THRESHOLD) adjacentDarkPixels += 1;
      }
      if (adjacentDarkPixels / height < TRACKER_MIN_HEIGHT_RATIO) break;
      end += 1;
    }
    if (end - start <= maximumWidth) columns.fill(1, start, end);
    start = end;
  }
  return columns;
}

function findVerticalInkBounds(
  data: Buffer,
  info: { readonly width: number; readonly height: number; readonly channels: number }
): { readonly top: number; readonly bottom: number } | null {
  let top = info.height;
  let bottom = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (isForeground(data, y * info.width + x, info.channels)) {
        top = Math.min(top, y);
        bottom = y;
        break;
      }
    }
  }
  return bottom < top ? null : { top, bottom };
}

function findDominantInkBounds(data: Buffer, width: number, height: number): { readonly left: number; readonly top: number; readonly width: number; readonly height: number } | null {
  const pixelCount = width * height;
  const visited = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let largestPixels = 0;
  let largest = { left: 0, top: 0, width, height };

  for (let start = 0; start < pixelCount; start += 1) {
    if (visited[start] === 1 || data[start] >= 180) continue;
    let head = 0;
    let tail = 1;
    let minX = start % width;
    let maxX = minX;
    let minY = Math.floor(start / width);
    let maxY = minY;
    queue[0] = start;
    visited[start] = 1;
    while (head < tail) {
      const pixel = queue[head++];
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      for (const neighbor of [x > 0 ? pixel - 1 : -1, x + 1 < width ? pixel + 1 : -1, y > 0 ? pixel - width : -1, y + 1 < height ? pixel + width : -1]) {
        if (neighbor >= 0 && visited[neighbor] === 0 && data[neighbor] < 180) {
          visited[neighbor] = 1;
          queue[tail++] = neighbor;
        }
      }
    }
    if (tail > largestPixels) {
      largestPixels = tail;
      largest = { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
    }
  }
  if (largestPixels === 0) return null;
  return largest;
}
