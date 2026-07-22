import type { RoiSample, ScoreRoiConfig } from "../../shared/roi-types";
import type { OffscreenInputFrame } from "../frame-sink";
import { RoiCropper } from "./roi-cropper";

export class RoiSampler {
  constructor(private readonly cropper = new RoiCropper()) {}

  sample(frame: OffscreenInputFrame, config: ScoreRoiConfig): RoiSample {
    const crop = this.cropper.crop(frame, config);
    return {
      id: `${frame.id}:roi`,
      sessionId: frame.sessionId,
      frameId: frame.id,
      timestampSec: frame.timing.timestampSec,
      frameIndex: frame.timing.frameIndex,
      roiRect: config.roiRect,
      image: {
        width: crop.width,
        height: crop.height,
        bitmapRef: crop
      }
    };
  }
}
