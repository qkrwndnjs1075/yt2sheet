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
      overwriteOutput: true,
      cookiesPath: resolve("C:/work", "private/cookies.txt")
    }
  });
});

test("parses separated and attached time-range options", () => {
  const result = parseCliArguments([
    "--start",
    "12.5",
    "--end=30",
    "https://youtu.be/1yCkz9VT3ZA"
  ], "C:/work");

  assert.deepEqual(result, {
    kind: "ok",
    command: {
      kind: "run",
      videoUrl: "https://youtu.be/1yCkz9VT3ZA",
      videoId: "1yCkz9VT3ZA",
      outputPath: resolve("C:/work", "yt2sheet", "yt2sheet-1yCkz9VT3ZA.pdf"),
      timeRange: {
        startTimeSec: 12.5,
        endTimeSec: 30
      }
    }
  });
});

test("preserves only the supplied time-range property", () => {
  const startOnly = parseCliArguments([
    "--start=0",
    "https://youtu.be/1yCkz9VT3ZA"
  ], "C:/work");
  const endOnly = parseCliArguments([
    "--end",
    "45",
    "https://youtu.be/1yCkz9VT3ZA"
  ], "C:/work");

  assert.deepEqual(startOnly, {
    kind: "ok",
    command: {
      kind: "run",
      videoUrl: "https://youtu.be/1yCkz9VT3ZA",
      videoId: "1yCkz9VT3ZA",
      outputPath: resolve("C:/work", "yt2sheet", "yt2sheet-1yCkz9VT3ZA.pdf"),
      timeRange: { startTimeSec: 0 }
    }
  });
  assert.deepEqual(endOnly, {
    kind: "ok",
    command: {
      kind: "run",
      videoUrl: "https://youtu.be/1yCkz9VT3ZA",
      videoId: "1yCkz9VT3ZA",
      outputPath: resolve("C:/work", "yt2sheet", "yt2sheet-1yCkz9VT3ZA.pdf"),
      timeRange: { endTimeSec: 45 }
    }
  });
});

test("rejects malformed, duplicate, and inverted time ranges", () => {
  const invalidValues = [
    "",
    "-1",
    "+1",
    "01",
    "1e2",
    "0x10",
    "NaN",
    "Infinity",
    "9".repeat(400)
  ];

  for (const value of invalidValues) {
    assert.equal(parseCliArguments([`--start=${value}`, "https://youtu.be/1yCkz9VT3ZA"], "C:/work").kind, "error");
  }
  assert.equal(parseCliArguments(["--start", "https://youtu.be/1yCkz9VT3ZA"], "C:/work").kind, "error");
  assert.equal(parseCliArguments(["--end", "https://youtu.be/1yCkz9VT3ZA"], "C:/work").kind, "error");
  const startEmptyAttachedArgs = new Proxy<readonly string[]>(["--start=", "https://youtu.be/1yCkz9VT3ZA"], {
    get(target, property, receiver) {
      if (property === "1") throw new Error("attached empty option consumed the URL");
      return Reflect.get(target, property, receiver);
    }
  });
  const endEmptyAttachedArgs = new Proxy<readonly string[]>(["--end=", "https://youtu.be/1yCkz9VT3ZA"], {
    get(target, property, receiver) {
      if (property === "1") throw new Error("attached empty option consumed the URL");
      return Reflect.get(target, property, receiver);
    }
  });

  assert.deepEqual(parseCliArguments(startEmptyAttachedArgs, "C:/work"), {
    kind: "error",
    message: "--start requires a decimal number."
  });
  assert.deepEqual(parseCliArguments(endEmptyAttachedArgs, "C:/work"), {
    kind: "error",
    message: "--end requires a decimal number."
  });
  assert.equal(parseCliArguments(["--start= 1", "https://youtu.be/1yCkz9VT3ZA"], "C:/work").kind, "error");
  assert.equal(parseCliArguments(["--start", " 1 ", "https://youtu.be/1yCkz9VT3ZA"], "C:/work").kind, "error");
  assert.equal(parseCliArguments(["--start=1", "--start=2", "https://youtu.be/1yCkz9VT3ZA"], "C:/work").kind, "error");
  assert.equal(parseCliArguments(["--end=1", "--end", "2", "https://youtu.be/1yCkz9VT3ZA"], "C:/work").kind, "error");
  assert.equal(parseCliArguments(["--start=5", "--end=5", "https://youtu.be/1yCkz9VT3ZA"], "C:/work").kind, "error");
  assert.equal(parseCliArguments(["--start=5", "--end=4", "https://youtu.be/1yCkz9VT3ZA"], "C:/work").kind, "error");
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
