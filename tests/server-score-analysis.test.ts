import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildPreprocessedFrame,
  findScoreCrop,
  hammingDistance,
  isNearDuplicate
} from "../server/score-analysis";

function scoreFrame(id: string, noteX = 28): ReturnType<typeof buildPreprocessedFrame> {
  const width = 160;
  const height = 100;
  const grayscale = new Uint8Array(width * height).fill(255);
  for (const top of [25, 60]) {
    for (let line = 0; line < 5; line += 1) {
      const y = top + line * 4;
      grayscale.fill(0, y * width + 8, y * width + 152);
    }
  }
  for (let y = 23; y < 45; y += 1) {
    grayscale[y * width + noteX] = 0;
  }
  return buildPreprocessedFrame({ id, width, height, grayscale });
}

describe("server score analysis", () => {
  it("finds a bounded crop around standard staff systems", () => {
    const crop = findScoreCrop(scoreFrame("score"));

    assert.ok(crop);
    assert.equal(crop.x, 0);
    assert.equal(crop.width, 160);
    assert.ok(crop.y <= 9);
    assert.ok(crop.y + crop.height >= 92);
  });

  it("rejects frames without repeated staff lines", () => {
    const grayscale = new Uint8Array(160 * 100).fill(255);
    assert.equal(findScoreCrop(buildPreprocessedFrame({ id: "blank", width: 160, height: 100, grayscale })), null);
  });

  it("finds a dense score system when notation joins the staff-line peak", () => {
    const crop = findScoreCrop(denseScoreFrame());

    assert.ok(crop);
  });

  it("finds a low-contrast staff system on a bright score panel", () => {
    const crop = findScoreCrop(lowContrastScoreFrame());

    assert.ok(crop);
  });

  it("keeps a paper-backed score when an unrelated component spans the frame edge", () => {
    const width = 240;
    const height = 240;
    const grayscale = new Uint8Array(width * height).fill(255);
    grayscale.fill(35, 0, width * 80);
    for (let y = 80; y < height; y += 1) grayscale[y * width + 8] = 0;
    for (let line = 0; line < 5; line += 1) grayscale.fill(0, (160 + line * 10) * width + 8, (160 + line * 10) * width + 232);

    const crop = findScoreCrop(buildPreprocessedFrame({ id: "score-with-frame-spanning-component", width, height, grayscale }));

    assert.ok(crop);
  });

  it("stops a score crop at a dark piano boundary below the white score panel", () => {
    const width = 160;
    const height = 140;
    const grayscale = new Uint8Array(width * height).fill(255);
    for (let y = 96; y < height; y += 1) {
      grayscale.fill(35, y * width, (y + 1) * width);
    }
    for (const top of [25, 60]) {
      for (let line = 0; line < 5; line += 1) {
        const y = top + line * 4;
        grayscale.fill(0, y * width + 8, y * width + 152);
      }
    }

    const crop = findScoreCrop(buildPreprocessedFrame({ id: "score-over-piano", width, height, grayscale }));

    assert.ok(crop);
    assert.ok(crop.y + crop.height <= 96, `crop bottom ${crop.y + crop.height} crossed into the piano`);
  });

  it("stops before a wide white-key piano that still looks paper-backed", () => {
    // Given: a score followed by bright piano keys joined by dark dividers.
    const width = 240;
    const height = 240;
    const keyboardTop = 145;
    const grayscale = new Uint8Array(width * height).fill(255);
    for (let line = 0; line < 5; line += 1) {
      const y = 80 + line * 10;
      grayscale.fill(0, y * width + 8, y * width + 232);
    }
    grayscale.fill(0, keyboardTop * width + 8, keyboardTop * width + 232);
    for (let x = 8; x <= 232; x += 16) {
      for (let y = keyboardTop; y < 215; y += 1) {
        grayscale[y * width + x] = 0;
      }
    }

    // When: the server locates the score crop.
    const crop = findScoreCrop(buildPreprocessedFrame({ id: "score-over-white-keys", width, height, grayscale }));

    // Then: the wide keyboard component is treated as the lower boundary.
    assert.ok(crop);
    assert.ok(crop.y + crop.height <= keyboardTop, `crop bottom ${crop.y + crop.height} crossed into the keys`);
  });

  it("rejects a bottom-edge piano that is falsely detected as a staff", () => {
    // Given: only a dense keyboard touching the lower frame edge.
    const width = 240;
    const height = 240;
    const grayscale = new Uint8Array(width * height).fill(255);
    for (const y of [170, 182, 194, 206, 218]) {
      grayscale.fill(0, y * width + 8, (y + 2) * width - 8);
    }
    for (let x = 8; x < 232; x += 16) {
      for (let y = 170; y < height; y += 1) {
        grayscale[y * width + x] = 0;
        grayscale[y * width + x + 1] = 0;
        grayscale[y * width + x + 2] = 0;
      }
    }

    // When: score detection evaluates the keyboard-only frame.
    const crop = findScoreCrop(buildPreprocessedFrame({ id: "bottom-piano-only", width, height, grayscale }));

    // Then: no score crop is emitted from the false staff candidate.
    assert.equal(crop, null);
  });

  it("keeps tempo and chord context inside the safe top margin", () => {
    const width = 160;
    const height = 150;
    const grayscale = new Uint8Array(width * height).fill(255);
    for (let line = 0; line < 5; line += 1) {
      const y = 80 + line * 4;
      grayscale.fill(0, y * width + 8, y * width + 152);
    }
    grayscale.fill(0, 30 * width + 20, 30 * width + 60);

    const crop = findScoreCrop(buildPreprocessedFrame({ id: "score-with-tempo", width, height, grayscale }));

    assert.ok(crop);
    assert.ok(crop.y <= 30, `crop top ${crop.y} removed musical context at row 30`);
  });

  it("keeps musical context more than nine staff gaps above a large staff", () => {
    const width = 240;
    const height = 280;
    const grayscale = new Uint8Array(width * height).fill(255);
    for (let line = 0; line < 5; line += 1) {
      const y = 150 + line * 10;
      grayscale.fill(0, y * width + 8, y * width + 232);
    }
    grayscale.fill(0, 45 * width + 20, 45 * width + 90);

    const crop = findScoreCrop(buildPreprocessedFrame({ id: "large-score-with-context", width, height, grayscale }));

    assert.ok(crop);
    assert.ok(crop.y <= 45, `crop top ${crop.y} removed musical context at row 45`);
  });

  it("keeps notation tails below the staff before a dark piano boundary", () => {
    const width = 240;
    const height = 220;
    const grayscale = new Uint8Array(width * height).fill(255);
    for (let line = 0; line < 5; line += 1) {
      const y = 80 + line * 10;
      grayscale.fill(0, y * width + 8, y * width + 232);
    }
    for (let y = 135; y <= 165; y += 1) {
      grayscale[y * width + 60] = 0;
    }
    for (let y = 175; y < height; y += 1) {
      grayscale.fill(35, y * width, (y + 1) * width);
    }

    const crop = findScoreCrop(buildPreprocessedFrame({ id: "score-with-low-notation", width, height, grayscale }));

    assert.ok(crop);
    assert.ok(crop.y + crop.height >= 166, `crop bottom ${crop.y + crop.height} removed notation ending at row 165`);
    assert.ok(crop.y + crop.height <= 175, `crop bottom ${crop.y + crop.height} crossed into the piano`);
  });

  it("does not mistake a three-row musical beam for a non-paper boundary", () => {
    const width = 240;
    const height = 220;
    const grayscale = new Uint8Array(width * height).fill(255);
    for (let line = 0; line < 5; line += 1) {
      const y = 100 + line * 10;
      grayscale.fill(0, y * width + 8, y * width + 232);
    }
    for (let y = 62; y <= 64; y += 1) {
      grayscale.fill(0, y * width + 20, y * width + 220);
    }
    grayscale.fill(0, 45 * width + 80, 45 * width + 120);

    const crop = findScoreCrop(buildPreprocessedFrame({ id: "score-with-upper-beam", width, height, grayscale }));

    assert.ok(crop);
    assert.ok(crop.y <= 45, `crop top ${crop.y} stopped on the musical beam and removed row 45`);
  });

  it("excludes a disconnected signature below the musical system", () => {
    const frame = scoreFrameWithBottomText();

    const crop = findScoreCrop(frame);
    const baselineCrop = findScoreCrop(scoreFrame("baseline"));

    assert.ok(crop);
    assert.ok(baselineCrop);
    assert.ok(crop.y + crop.height < 105, `crop bottom ${crop.y + crop.height} retained signature text at row 105`);
    assert.equal(crop.height, baselineCrop.height);
  });

  it("normalizes internal score padding when the same system moves vertically", () => {
    const firstCrop = findScoreCrop(shiftedScoreFrame("first-position", 60));
    const secondCrop = findScoreCrop(shiftedScoreFrame("second-position", 80));

    assert.ok(firstCrop);
    assert.ok(secondCrop);
    assert.equal(firstCrop.height, secondCrop.height);
  });

  it("keeps a nearby upper staff fragment inside the expanded context margin", () => {
    const width = 160;
    const height = 150;
    const grayscale = new Uint8Array(width * height).fill(255);
    for (const y of [44, 48, 52, 80, 84, 88, 92, 96]) {
      grayscale.fill(0, y * width + 8, y * width + 152);
    }

    const crop = findScoreCrop(buildPreprocessedFrame({ id: "partial-grand-staff", width, height, grayscale }));

    assert.ok(crop);
    assert.ok(crop.y <= 44, `crop top ${crop.y} removed the upper staff context at row 44`);
  });

  it("keeps matching perceptual hashes together and changed notation apart", () => {
    const sameA = Uint8Array.from([0b10101010, 0b01010101]);
    const sameB = Uint8Array.from([0b10101010, 0b01010100]);
    const changed = Uint8Array.from([0b01010101, 0b10101010]);

    assert.equal(hammingDistance(sameA, sameB), 1);
    assert.equal(isNearDuplicate(sameA, sameB), true);
    assert.equal(isNearDuplicate(sameA, changed), false);
  });

  it("does not merge score hashes that differ by eleven notation bits", () => {
    const first = new Uint8Array(16);
    const changedNotation = new Uint8Array(16);
    changedNotation[0] = 0xff;
    changedNotation[1] = 0x07;

    assert.equal(hammingDistance(first, changedNotation), 11);
    assert.equal(isNearDuplicate(first, changedNotation), false);
  });
});

function scoreFrameWithBottomText(): ReturnType<typeof buildPreprocessedFrame> {
  const width = 160;
  const height = 140;
  const grayscale = new Uint8Array(width * height).fill(255);
  for (const top of [25, 60]) {
    for (let line = 0; line < 5; line += 1) {
      const y = top + line * 4;
      grayscale.fill(0, y * width + 8, y * width + 152);
    }
  }
  for (let y = 105; y <= 112; y += 1) {
    grayscale.fill(0, y * width + 120, y * width + 150);
  }
  return buildPreprocessedFrame({ id: "score-with-signature", width, height, grayscale });
}

function denseScoreFrame(): ReturnType<typeof buildPreprocessedFrame> {
  const width = 240;
  const height = 180;
  const grayscale = new Uint8Array(width * height).fill(255);
  for (let line = 0; line < 5; line += 1) {
    const y = 60 + line * 10;
    grayscale.fill(0, y * width + 8, y * width + 232);
  }
  for (let y = 60; y <= 100; y += 1) {
    grayscale.fill(0, y * width + 108, y * width + 132);
  }
  return buildPreprocessedFrame({ id: "dense-score", width, height, grayscale });
}

function lowContrastScoreFrame(): ReturnType<typeof buildPreprocessedFrame> {
  const width = 240;
  const height = 180;
  const grayscale = new Uint8Array(width * height).fill(245);
  for (const top of [60, 110]) {
    for (let line = 0; line < 5; line += 1) {
      const y = top + line * 6;
      grayscale.fill(210, y * width + 8, y * width + 232);
    }
  }
  return buildPreprocessedFrame({ id: "low-contrast-score", width, height, grayscale });
}

function shiftedScoreFrame(id: string, top: number): ReturnType<typeof buildPreprocessedFrame> {
  const width = 160;
  const height = 180;
  const grayscale = new Uint8Array(width * height).fill(255);
  for (const staffTop of [top, top + 35]) {
    for (let line = 0; line < 5; line += 1) {
      const y = staffTop + line * 4;
      grayscale.fill(0, y * width + 8, y * width + 152);
    }
  }
  return buildPreprocessedFrame({ id, width, height, grayscale });
}
