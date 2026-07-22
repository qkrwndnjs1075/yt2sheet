import type { RoiSample } from "../../shared/roi-types";

export type ImageBlobMetadata = {
  id: string;
  width: number;
  height: number;
  type: string;
};

export interface ImageBlobRepository {
  saveSampleImage(sample: RoiSample): Promise<string>;
  saveBlob(id: string, blob: Blob, metadata: Omit<ImageBlobMetadata, "id" | "type"> & { type?: string }): Promise<string>;
  loadBlob(id: string): Promise<Blob>;
  loadImageBitmap(id: string): Promise<ImageBitmap>;
  getMetadata(id: string): Promise<ImageBlobMetadata | null>;
  delete(id: string): Promise<void>;
}

export class InMemoryImageBlobRepository implements ImageBlobRepository {
  private readonly blobs = new Map<string, Blob>();
  private readonly metadata = new Map<string, ImageBlobMetadata>();

  async saveSampleImage(sample: RoiSample): Promise<string> {
    const id = `roi-sample:${sample.id}`;
    const blob = await canvasSourceToBlob(sample.image.bitmapRef, sample.image.width, sample.image.height);
    await this.saveBlob(id, blob, {
      width: sample.image.width,
      height: sample.image.height,
      type: blob.type || "image/png"
    });
    return id;
  }

  async saveBlob(id: string, blob: Blob, metadata: Omit<ImageBlobMetadata, "id" | "type"> & { type?: string }): Promise<string> {
    this.blobs.set(id, blob);
    this.metadata.set(id, {
      id,
      width: metadata.width,
      height: metadata.height,
      type: metadata.type ?? blob.type
    });
    return id;
  }

  async loadBlob(id: string): Promise<Blob> {
    const blob = this.blobs.get(id);
    if (!blob) {
      throw new Error(`Image blob not found: ${id}`);
    }
    return blob;
  }

  async loadImageBitmap(id: string): Promise<ImageBitmap> {
    const blob = await this.loadBlob(id);
    return createImageBitmap(blob);
  }

  async getMetadata(id: string): Promise<ImageBlobMetadata | null> {
    return this.metadata.get(id) ?? null;
  }

  async delete(id: string): Promise<void> {
    this.blobs.delete(id);
    this.metadata.delete(id);
  }
}

async function canvasSourceToBlob(source: RoiSample["image"]["bitmapRef"], width: number, height: number): Promise<Blob> {
  if ("convertToBlob" in source && typeof source.convertToBlob === "function") {
    return source.convertToBlob({ type: "image/png" });
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Unable to create sample image canvas context.");
  }

  context.drawImage(source, 0, 0, width, height);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Unable to encode sample image blob."));
      }
    }, "image/png");
  });
}
