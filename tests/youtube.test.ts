import assert from "node:assert/strict";
import { test } from "node:test";
import { isYouTubeWatchUrl, parseYouTubeVideoId } from "../cli/youtube.js";

test("validates YouTube watch URLs only", () => {
  assert.equal(isYouTubeWatchUrl("https://www.youtube.com/watch?v=abc123XYZ_0"), true);
  assert.equal(isYouTubeWatchUrl("https://m.youtube.com/watch?v=abc123XYZ_0&t=20"), true);
  assert.equal(isYouTubeWatchUrl("https://youtu.be/abc123XYZ_0"), false);
  assert.equal(isYouTubeWatchUrl("https://www.youtube.com/shorts/abc123XYZ_0"), false);
  assert.equal(isYouTubeWatchUrl("https://example.com/watch?v=abc123XYZ_0"), false);
});

test("parses supported YouTube video ids", () => {
  assert.equal(parseYouTubeVideoId("https://www.youtube.com/watch?v=abc123XYZ_0"), "abc123XYZ_0");
  assert.equal(parseYouTubeVideoId("http://www.youtube.com/watch?v=abc123XYZ_0"), "abc123XYZ_0");
  assert.equal(parseYouTubeVideoId("https://youtu.be/abc123XYZ_0"), "abc123XYZ_0");
  assert.equal(parseYouTubeVideoId("https://www.youtube.com/shorts/abc123XYZ_0"), "abc123XYZ_0");
  assert.equal(parseYouTubeVideoId("https://www.youtube.com/live/abc123XYZ_0?si=share-token"), "abc123XYZ_0");
  assert.equal(parseYouTubeVideoId("https://www.youtube.com/embed/abc123XYZ_0"), "abc123XYZ_0");
  assert.equal(parseYouTubeVideoId("not a url"), null);
});

test("rejects unsupported URL schemes and video ids that are not exactly 11 characters", () => {
  assert.equal(parseYouTubeVideoId("ftp://youtube.com/watch?v=abc123XYZ_0"), null);
  assert.equal(parseYouTubeVideoId("https://youtube.com/watch?v=abcdef"), null);
  assert.equal(parseYouTubeVideoId("https://youtube.com/watch?v=abc123XYZ_00"), null);
  assert.equal(parseYouTubeVideoId("https://youtube.com/watch?v=abc123XYZ_0"), "abc123XYZ_0");
});
