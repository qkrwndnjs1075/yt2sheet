import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { parseCliArguments } from "../cli/arguments";

test("parses a YouTube URL with the default PDF path", () => {
  const result = parseCliArguments(["https://www.youtube.com/watch?v=1yCkz9VT3ZA"], "C:/work");

  assert.deepEqual(result, {
    kind: "ok",
    command: {
      kind: "run",
      videoUrl: "https://www.youtube.com/watch?v=1yCkz9VT3ZA",
      videoId: "1yCkz9VT3ZA",
      outputPath: resolve("C:/work", "yt2sheet", "yt2sheet-1yCkz9VT3ZA.pdf")
    }
  });
});

test("parses output and cookie options", () => {
  const result = parseCliArguments([
    "--output",
    "exports/song.pdf",
    "--cookies",
    "private/cookies.txt",
    "https://youtu.be/1yCkz9VT3ZA"
  ], "C:/work");

  assert.deepEqual(result, {
    kind: "ok",
    command: {
      kind: "run",
      videoUrl: "https://youtu.be/1yCkz9VT3ZA",
      videoId: "1yCkz9VT3ZA",
      outputPath: resolve("C:/work", "exports/song.pdf"),
      cookiesPath: resolve("C:/work", "private/cookies.txt")
    }
  });
});

test("returns help for conventional help entry points", () => {
  assert.deepEqual(parseCliArguments([], "C:/work"), { kind: "help" });
  assert.deepEqual(parseCliArguments(["help"], "C:/work"), { kind: "help" });
  assert.deepEqual(parseCliArguments(["--help"], "C:/work"), { kind: "help" });
  assert.deepEqual(parseCliArguments(["-h"], "C:/work"), { kind: "help" });
});

test("recognizes the standalone uninstall command without accepting extra arguments", () => {
  assert.deepEqual(parseCliArguments(["uninstall"], "C:/work"), { kind: "uninstall" });
  assert.deepEqual(parseCliArguments(["uninstall", "extra"], "C:/work"), {
    kind: "error",
    message: "uninstall 명령은 추가 인자를 받지 않습니다."
  });
});

test("rejects invalid or incomplete arguments", () => {
  assert.equal(parseCliArguments(["not-a-youtube-url"], "C:/work").kind, "error");
  assert.equal(parseCliArguments(["--output"], "C:/work").kind, "error");
  assert.equal(parseCliArguments(["https://youtu.be/1yCkz9VT3ZA", "extra"], "C:/work").kind, "error");
  assert.equal(parseCliArguments(["--unknown", "value"], "C:/work").kind, "error");
});
