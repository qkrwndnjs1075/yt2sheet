import assert from "node:assert/strict";
import { test } from "node:test";
import { isYouTubeWatchUrl, parseYouTubeVideoId } from "../src/shared/youtube.js";

test("validates YouTube watch URLs only", () => {
  assert.equal(isYouTubeWatchUrl("https://www.youtube.com/watch?v=abc123XYZ_0"), true);
  assert.equal(isYouTubeWatchUrl("https://m.youtube.com/watch?v=abc123XYZ_0&t=20"), true);
  assert.equal(isYouTubeWatchUrl("https://youtu.be/abc123XYZ_0"), false);
  assert.equal(isYouTubeWatchUrl("https://www.youtube.com/shorts/abc123XYZ_0"), false);
  assert.equal(isYouTubeWatchUrl("https://example.com/watch?v=abc123XYZ_0"), false);
});

test("parses supported YouTube video ids", () => {
  assert.equal(parseYouTubeVideoId("https://www.youtube.com/watch?v=abc123XYZ_0"), "abc123XYZ_0");
  assert.equal(parseYouTubeVideoId("https://youtu.be/abc123XYZ_0"), "abc123XYZ_0");
  assert.equal(parseYouTubeVideoId("not a url"), null);
});
