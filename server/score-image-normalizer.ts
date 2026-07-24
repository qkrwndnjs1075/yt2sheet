import sharp from "sharp";
import { cleanScoreImageArtifacts } from "./score-image-artifact-cleanup";
import { isForeground } from "./score-image-pixels";

const PAPER_CHANNEL_MIN = 205;
const PAPER_CHROMA_MAX = 12;
const PHOTO_COMPONENT_RATIO = 0.003;
const PHOTO_COLOR_PIXELS_MIN = 64;
const PHOTO_BOUNDS_PADDING_RATIO = 0.12;

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

export async function createDominantInkHash(image: Buffer): Promise<Uint8Array> {
  const raw = await sharp(image).greyscale().raw().toBuffer({ resolveWithObject: true });
  const bounds = findDominantInkBounds(raw.data, raw.info.width, raw.info.height);
  const dominantInk = await sharp(image).extract(bounds).png().toBuffer();
  return createDifferenceHash(dominantInk);
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

function findDominantInkBounds(data: Buffer, width: number, height: number): { readonly left: number; readonly top: number; readonly width: number; readonly height: number } {
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
  if (largestPixels === 0) throw new RangeError("Score image does not contain dominant notation ink.");
  return largest;
}
