import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { observeShadowFrame } from "../benchmarks/diagnostics";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("benchmark shadow diagnostics", () => {
  it("returns observations only and leaves low-contrast input bytes unchanged", () => {
    // Given
    const grayscale = Uint8Array.from([120, 121, 122, 123, 124, 125, 126, 127, 128]);
    const before = sha256(grayscale);
    // When
    const observation = observeShadowFrame({ enabled: true, width: 3, height: 3, grayscale });
    // Then
    assert.equal(observation?.inputByteSha256, before);
    assert.equal(sha256(grayscale), before);
    assert.deepEqual(Object.keys(observation ?? {}).sort(), ["globalThreshold", "inputByteSha256", "meanLocalContrast", "staffLikeRowRatio", "thresholdDisagreementRatio"]);
    assert.ok((observation?.meanLocalContrast ?? Infinity) < 10);
  });

  it("observes clear staff rows without changing the caller decision or normalized input hash", () => {
    // Given
    const grayscale = new Uint8Array(20 * 10).fill(255);
    for (const row of [1, 3, 5, 7, 9]) grayscale.fill(0, row * 20, (row + 1) * 20);
    const runShadowedDecision = (enabled: boolean) => {
      const observation = observeShadowFrame({ enabled, width: 20, height: 10, grayscale });
      const normalizedInput = grayscale.map((pixel) => pixel < 128 ? 0 : 255);
      return {
        observation,
        decision: { accepted: normalizedInput.includes(0), cropCount: normalizedInput.includes(0) ? 1 : 0 },
        normalizedInputByteSha256: sha256(normalizedInput)
      };
    };
    // When
    const disabled = runShadowedDecision(false);
    const enabled = runShadowedDecision(true);
    // Then
    assert.equal(disabled.observation, null);
    assert.ok((enabled.observation?.staffLikeRowRatio ?? 0) >= 0.5);
    assert.deepEqual(enabled.decision, disabled.decision);
    assert.equal(enabled.normalizedInputByteSha256, disabled.normalizedInputByteSha256);
  });
});
