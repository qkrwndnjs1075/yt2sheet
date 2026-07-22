import type { DebugCaptureState } from "../shared/debug-state";
import {
  CAPTURE_IMAGE_KEY_PREFIX,
  captureImageKeys,
  compactCaptureImages,
  hydrateCaptureImages,
  type CaptureImageEntries
} from "./capture-image-state";

type StorageArea = {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
};

export class CaptureImageStorage {
  private readonly knownKeys = new Set<string>();

  constructor(private readonly storage: StorageArea = chrome.storage.local) {}

  async persist(state: DebugCaptureState): Promise<DebugCaptureState> {
    const compacted = compactCaptureImages(state);
    const newImages = Object.fromEntries(
      Object.entries(compacted.images).filter(([key]) => !this.knownKeys.has(key))
    );
    const newKeys = Object.keys(newImages);
    if (newKeys.length > 0) {
      await this.storage.set(newImages);
      newKeys.forEach((key) => this.knownKeys.add(key));
    }
    return compacted.state;
  }

  async hydrate(state: DebugCaptureState): Promise<DebugCaptureState> {
    const keys = captureImageKeys(state);
    if (keys.length === 0) {
      return state;
    }

    const stored = await this.storage.get(keys);
    const images: CaptureImageEntries = {};
    for (const key of keys) {
      if (typeof stored[key] === "string") {
        images[key] = stored[key] as string;
        this.knownKeys.add(key);
      }
    }
    return hydrateCaptureImages(state, images);
  }

  async clear(): Promise<void> {
    const stored = await this.storage.get(null);
    const keys = Object.keys(stored).filter((key) => key.startsWith(CAPTURE_IMAGE_KEY_PREFIX));
    if (keys.length > 0) {
      await this.storage.remove(keys);
    }
    this.knownKeys.clear();
  }
}
