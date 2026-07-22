import type { NormalizedScoreImage } from "../../shared/fingerprint-types";

const DARK_THRESHOLD = 150;
const STAFF_ROW_DENSITY = 0.42;

export class StaffLineSuppressor {
  suppress(image: NormalizedScoreImage): NormalizedScoreImage {
    const pixels = new Uint8ClampedArray(image.pixels);
    const staffRows = detectStaffRows(image);

    for (const row of staffRows) {
      for (let x = 0; x < image.width; x += 1) {
        const index = row * image.width + x;
        if (pixels[index] < DARK_THRESHOLD) {
          pixels[index] = Math.max(pixels[index], 225);
        }
      }
    }

    return {
      ...image,
      pixels
    };
  }
}

function detectStaffRows(image: NormalizedScoreImage): number[] {
  const rows: number[] = [];

  for (let y = 0; y < image.height; y += 1) {
    let darkCount = 0;
    for (let x = 0; x < image.width; x += 1) {
      if (image.pixels[y * image.width + x] < DARK_THRESHOLD) {
        darkCount += 1;
      }
    }

    if (darkCount / image.width >= STAFF_ROW_DENSITY) {
      rows.push(y);
    }
  }

  return rows.filter((row, index) => index === 0 || row - rows[index - 1] > 1);
}
