import type { NormalizedScoreImage, ScoreFingerprint } from "../../shared/fingerprint-types";
import type { RoiSample } from "../../shared/roi-types";
import { ScoreNormalizer } from "./score-normalizer";
import { extractStaffContent } from "./staff-content-extractor";
import { StaffLineSuppressor } from "./staff-line-suppressor";

const HASH_SIZE = 8;
const PHASH_SIZE = 8;
const PROJECTION_VERTICAL_BINS = 64;
const PROJECTION_HORIZONTAL_BINS = 32;
const DARK_THRESHOLD = 150;

export class FingerprintGenerator {
  constructor(private readonly staffLineSuppressor = new StaffLineSuppressor()) {}

  generate(image: NormalizedScoreImage, sourceAspectRatio = image.width / Math.max(1, image.height)): ScoreFingerprint {
    const staffContent = extractStaffContent(image);
    const content = this.staffLineSuppressor.suppress(staffContent);
    return {
      fullPHash: averageHash(image, PHASH_SIZE, PHASH_SIZE),
      fullDHash: differenceHash(image),
      contentPHash: averageHash(content, PHASH_SIZE, PHASH_SIZE),
      contentDHash: differenceHash(content),
      horizontalProjection: projection(content, "horizontal", PROJECTION_HORIZONTAL_BINS),
      verticalProjection: projection(content, "vertical", PROJECTION_VERTICAL_BINS),
      aspectRatio: sourceAspectRatio,
      inkDensity: inkDensity(content)
    };
  }
}

export class ScoreFingerprintGenerator {
  constructor(
    private readonly normalizer = new ScoreNormalizer(),
    private readonly fingerprintGenerator = new FingerprintGenerator()
  ) {}

  generate(sample: RoiSample): ScoreFingerprint {
    const normalized = this.normalizer.normalize(sample);
    return this.generateFromNormalized(normalized, sample.image.width / Math.max(1, sample.image.height));
  }

  generateFromNormalized(image: NormalizedScoreImage, sourceAspectRatio = image.width / Math.max(1, image.height)): ScoreFingerprint {
    return this.fingerprintGenerator.generate(image, sourceAspectRatio);
  }
}

function averageHash(image: NormalizedScoreImage, width: number, height: number): string {
  const values = resizeToValues(image, width, height);
  const avg = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  return bitsToHex(values.map((value) => value < avg));
}

function differenceHash(image: NormalizedScoreImage): string {
  const values = resizeToValues(image, HASH_SIZE + 1, HASH_SIZE);
  const bits: boolean[] = [];

  for (let y = 0; y < HASH_SIZE; y += 1) {
    for (let x = 0; x < HASH_SIZE; x += 1) {
      const left = values[y * (HASH_SIZE + 1) + x];
      const right = values[y * (HASH_SIZE + 1) + x + 1];
      bits.push(left > right);
    }
  }

  return bitsToHex(bits);
}

function resizeToValues(image: NormalizedScoreImage, width: number, height: number): number[] {
  const values: number[] = [];
  const scaleX = image.width / width;
  const scaleY = image.height / height;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const startX = Math.floor(x * scaleX);
      const endX = Math.max(startX + 1, Math.floor((x + 1) * scaleX));
      const startY = Math.floor(y * scaleY);
      const endY = Math.max(startY + 1, Math.floor((y + 1) * scaleY));
      let sum = 0;
      let count = 0;

      for (let yy = startY; yy < Math.min(image.height, endY); yy += 1) {
        for (let xx = startX; xx < Math.min(image.width, endX); xx += 1) {
          sum += image.pixels[yy * image.width + xx];
          count += 1;
        }
      }

      values.push(sum / Math.max(1, count));
    }
  }

  return values;
}

function projection(image: NormalizedScoreImage, axis: "horizontal" | "vertical", bins: number): number[] {
  const values = new Array<number>(bins).fill(0);
  const counts = new Array<number>(bins).fill(0);
  const length = axis === "horizontal" ? image.height : image.width;

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const index = y * image.width + x;
      const bin = Math.min(bins - 1, Math.floor(((axis === "horizontal" ? y : x) / length) * bins));
      values[bin] += image.pixels[index] < DARK_THRESHOLD ? 1 : 0;
      counts[bin] += 1;
    }
  }

  return values.map((value, index) => value / Math.max(1, counts[index]));
}

function inkDensity(image: NormalizedScoreImage): number {
  let dark = 0;
  for (const pixel of image.pixels) {
    if (pixel < DARK_THRESHOLD) {
      dark += 1;
    }
  }
  return dark / Math.max(1, image.pixels.length);
}

function bitsToHex(bits: boolean[]): string {
  let output = "";
  for (let i = 0; i < bits.length; i += 4) {
    const nibble = bits.slice(i, i + 4).reduce((value, bit, index) => value + (bit ? 1 << (3 - index) : 0), 0);
    output += nibble.toString(16);
  }
  return output;
}
