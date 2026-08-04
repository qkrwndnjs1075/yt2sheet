import test from "node:test";
import assert from "node:assert/strict";
import { main } from "../cli/index";

test("CLI main accepts an injected job executor for compiled stream verification", async () => {
  const output: string[] = [];
  const errors: string[] = [];
  const oldStdout = process.stdout.write;
  const oldStderr = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    errors.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    await main(["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "--output", "./compiled-test.pdf"], {
      runJob: async (command) => ({ outputPath: command.outputPath, pageCount: 1 })
    });
  } finally {
    process.stdout.write = oldStdout;
    process.stderr.write = oldStderr;
  }
  assert.equal(output.join(""), `${process.cwd()}/compiled-test.pdf\n`);
  assert.equal(errors.join(""), [
    "[1/9] info 0%", "[2/9] download 12%", "[3/9] extraction 32%", "[4/9] raster analysis 45%",
    "[5/9] raster review 75%", "[6/9] OMR 80%", "[7/9] MusicXML validation 85%", "[8/9] engraving 90%",
    "[9/9] PDF publication 100%"
  ].join("\n") + "\n");
});
