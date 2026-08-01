import { createHash } from "node:crypto";

export type ShadowFrameInput = {
  readonly enabled: boolean;
  readonly width: number;
  readonly height: number;
  readonly grayscale: Uint8Array;
};

export type ShadowFrameObservation = {
  readonly inputByteSha256: string;
  readonly globalThreshold: number;
  readonly meanLocalContrast: number;
  readonly thresholdDisagreementRatio: number;
  readonly staffLikeRowRatio: number;
};

function validateDimensions(input: ShadowFrameInput): void {
  if (!Number.isInteger(input.width) || input.width <= 0 || !Number.isInteger(input.height) || input.height <= 0) {
    throw new RangeError("Shadow diagnostic dimensions must be positive integers.");
  }
  if (input.grayscale.length !== input.width * input.height) {
    throw new RangeError("Shadow diagnostic dimensions do not match the pixel buffer.");
  }
}

export function observeShadowFrame(input: ShadowFrameInput): ShadowFrameObservation | null {
  if (!input.enabled) return null;
  validateDimensions(input);
  const globalThreshold = input.grayscale.reduce((sum, pixel) => sum + pixel, 0) / input.grayscale.length;
  let contrastSum = 0;
  let disagreements = 0;
  let staffLikeRows = 0;

  for (let y = 0; y < input.height; y += 1) {
    let rowDarkPixels = 0;
    for (let x = 0; x < input.width; x += 1) {
      const pixel = input.grayscale[y * input.width + x];
      let localMin = 255;
      let localMax = 0;
      let localSum = 0;
      let localCount = 0;
      for (let localY = Math.max(0, y - 1); localY <= Math.min(input.height - 1, y + 1); localY += 1) {
        for (let localX = Math.max(0, x - 1); localX <= Math.min(input.width - 1, x + 1); localX += 1) {
          const localPixel = input.grayscale[localY * input.width + localX];
          localMin = Math.min(localMin, localPixel);
          localMax = Math.max(localMax, localPixel);
          localSum += localPixel;
          localCount += 1;
        }
      }
      contrastSum += localMax - localMin;
      const globalDark = pixel < globalThreshold;
      const localDark = pixel < localSum / localCount;
      if (globalDark !== localDark) disagreements += 1;
      if (globalDark) rowDarkPixels += 1;
    }
    if (rowDarkPixels / input.width >= 0.6) staffLikeRows += 1;
  }

  return {
    inputByteSha256: createHash("sha256").update(input.grayscale).digest("hex"),
    globalThreshold,
    meanLocalContrast: contrastSum / input.grayscale.length,
    thresholdDisagreementRatio: disagreements / input.grayscale.length,
    staffLikeRowRatio: staffLikeRows / input.height
  };
}
