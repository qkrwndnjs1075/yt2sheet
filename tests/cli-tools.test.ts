import assert from "node:assert/strict";
import test from "node:test";
import { selectYtDlpAsset } from "../cli/yt-dlp-bootstrap";

test("selects yt-dlp assets for supported operating systems", () => {
  assert.deepEqual(selectYtDlpAsset("win32", "x64"), { name: "yt-dlp.exe", fileName: "yt-dlp.exe" });
  assert.deepEqual(selectYtDlpAsset("win32", "arm64"), { name: "yt-dlp_arm64.exe", fileName: "yt-dlp.exe" });
  assert.deepEqual(selectYtDlpAsset("darwin", "arm64"), { name: "yt-dlp_macos", fileName: "yt-dlp" });
  assert.deepEqual(selectYtDlpAsset("linux", "x64"), { name: "yt-dlp_linux", fileName: "yt-dlp" });
  assert.deepEqual(selectYtDlpAsset("linux", "arm64"), { name: "yt-dlp_linux_aarch64", fileName: "yt-dlp" });
});

test("rejects unsupported operating systems", () => {
  assert.throws(() => selectYtDlpAsset("freebsd", "x64"), /지원하지 않습니다/);
});
