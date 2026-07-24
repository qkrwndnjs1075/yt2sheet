export function isForeground(data: Buffer, pixel: number, channels: number): boolean {
  const offset = pixel * channels;
  return Math.min(data[offset], data[offset + 1], data[offset + 2]) < 250;
}
