import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { strToU8, zipSync, type Zippable } from "fflate";
import { MusicXmlValidationError, validateMusicXml, validateMxl } from "../pipeline/musicxml-validator";

const FIXTURES = join(process.cwd(), "tests", "fixtures", "musicxml-validator");

test("validates a minimal MusicXML 4.0 partwise score offline", async () => {
  // Given: a minimal standards-shaped partwise MusicXML document.
  const xml = await readFile(join(FIXTURES, "minimal-partwise.musicxml"));

  // When: the document is validated against the pinned local schemas.
  const result = await validateMusicXml(xml);

  // Then: validation identifies the partwise root without any external lookup.
  assert.deepEqual(result, { format: "musicxml", root: "score-partwise" });
});

test("validates official minimal partwise, timewise, and MXL shapes without network requests", async (t) => {
  // Given: both score organizations, an MXL wrapper, and an observable local HTTP canary.
  const partwise = await fixture("minimal-partwise.musicxml");
  const timewise = await fixture("minimal-timewise.musicxml");
  const archive = mxl(partwise);
  const canary = await startCanary(t);

  // When: each artifact is validated repeatedly while the canary is available.
  const results = await Promise.all([
    validateMusicXml(partwise),
    validateMusicXml(timewise),
    validateMxl(archive),
    ...Array.from({ length: 12 }, () => validateMxl(archive))
  ]);

  // Then: all validations identify their roots and no HTTP request is attempted.
  assert.deepEqual(results.slice(0, 3), [
    { format: "musicxml", root: "score-partwise" },
    { format: "musicxml", root: "score-timewise" },
    { format: "mxl", root: "score-partwise" }
  ]);
  assert.equal(canary.requests(), 0);
  t.diagnostic(JSON.stringify({ scenario: "offline-happy", partwise: true, timewise: true, mxl: true, repeatCount: 12, canaryRequests: canary.requests() }));
});

test("rejects malformed schema values, DOCTYPE, XXE, and external schema resolution", async (t) => {
  // Given: invalid notes and XML constructs capable of external resolution.
  const canary = await startCanary(t);
  const port = canary.port;
  const inputs = [
    await fixture("malformed-note.musicxml"),
    strToU8(`<!DOCTYPE score-partwise SYSTEM "http://127.0.0.1:${port}/dtd"><score-partwise version="4.0"/>`),
    strToU8(`<!DOCTYPE score-partwise [<!ENTITY xxe SYSTEM "http://127.0.0.1:${port}/xxe">]><score-partwise version="4.0">&xxe;</score-partwise>`),
    strToU8(`<score-partwise xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://127.0.0.1:${port}/schema.xsd" version="4.0"/>`)
  ];

  // When: every untrusted document is validated.
  const errors = await Promise.all(inputs.map(captureMusicXmlError));

  // Then: validation fails locally with stable codes and the canary remains untouched.
  assert.deepEqual(errors.map((error) => error.code), Array(inputs.length).fill("MUSICXML_INVALID"));
  assert.equal(canary.requests(), 0);
  t.diagnostic(JSON.stringify({ scenario: "xml-resolution-failure", codes: errors.map((error) => error.code), canaryRequests: canary.requests() }));
});

test("treats prompt-injection text as inert score content", async () => {
  // Given: valid MusicXML whose external text contains an instruction-like phrase.
  const xml = await fixture("prompt-injection.musicxml");

  // When: schema validation reads the score.
  const result = await validateMusicXml(xml);

  // Then: the phrase changes no validator control flow.
  assert.deepEqual(result, { format: "musicxml", root: "score-partwise" });
});

test("rejects documents that do not declare MusicXML version 4.0", async () => {
  // Given: schema-valid score shapes labeled as a later or nonsensical version.
  const source = await readFile(join(FIXTURES, "minimal-partwise.musicxml"), "utf8");
  const inputs = ["4.1", "banana"].map((version) => strToU8(source.replace('version="4.0"', `version="${version}"`)));

  // When: strict MusicXML 4.0 validation is requested.
  const errors = await Promise.all(inputs.map(captureMusicXmlError));

  // Then: neither value can pass by exploiting the schema's token-typed version attribute.
  assert.deepEqual(errors.map((error) => [error.code, error.reason]), [
    ["MUSICXML_INVALID", "version"],
    ["MUSICXML_INVALID", "version"]
  ]);
});

test("rejects the adversarial MXL archive matrix before unsafe extraction", async (t) => {
  // Given: independently malformed archives covering every bounded ZIP policy.
  const score = await fixture("minimal-partwise.musicxml");
  const cases = new Map<string, Uint8Array>([
    ["malformed", strToU8("not-a-zip")],
    ["traversal", mxl(score, { "../escape.musicxml": score })],
    ["absolute", mxl(score, { "/escape.musicxml": score })],
    ["symlink", mxl(score, { "link": [strToU8("score.musicxml"), { os: 3, attrs: 0o120777 << 16 }] })],
    ["duplicate-container", duplicateContainer(score)],
    ["encrypted", mutateEncrypted(mxl(score))],
    ["multi-disk", mutateDiskNumber(mxl(score))],
    ["129-entries", tooManyEntries(score)],
    ["101-ratio", mxl(score, { "bomb.bin": new Uint8Array(20_000) })],
    ["physical-archive-64m", prefixArchive(mxl(score), 65 * 1024 * 1024)],
    ["compressed-64m", mutateCentralSizes(mxl(score), 0, 65 * 1024 * 1024, 65 * 1024 * 1024)],
    ["uncompressed-256m", mutateCentralSizes(mxl(score), 0, 3 * 1024 * 1024, 257 * 1024 * 1024)],
    ["xml-32m", mutateNamedUncompressedSize(mxl(score), "score.musicxml", 33 * 1024 * 1024)],
    ["duplicate-rootfile", mxl(score, {}, containerXml("score.musicxml", "score.musicxml"))],
    ["container-doctype", mxl(score, {}, strToU8('<!DOCTYPE container SYSTEM "file:///etc/passwd"><container/>'))]
  ]);

  // When: every archive is validated without an extraction directory.
  const errors = await Promise.all(Array.from(cases, async ([name, archive]) => [name, await captureMxlError(archive)] as const));

  // Then: each outcome is the stable unsafe code and no archive writes to disk.
  for (const [name, error] of errors) await t.test(name, () => {
    assert.equal(error.code, "MXL_UNSAFE");
    if (name === "physical-archive-64m") assert.equal(error.reason, "compressed-size");
  });
  t.diagnostic(JSON.stringify({ scenario: "mxl-unsafe-matrix", outcomes: Object.fromEntries(errors.map(([name, error]) => [name, { code: error.code, reason: error.reason }])) }));
});

test("rejects missing and undeclared MXL rootfiles", async () => {
  // Given: containers that select an absent file or declare multiple normalized roots.
  const score = await fixture("minimal-partwise.musicxml");
  const archives = [
    mxl(score, {}, containerXml("missing.musicxml")),
    mxl(score, { "other.musicxml": score }, containerXml("score.musicxml", "other.musicxml"))
  ];

  // When: rootfile selection is validated.
  const errors = await Promise.all(archives.map(captureMxlError));

  // Then: neither ambiguous nor absent roots reach score decompression.
  assert.deepEqual(errors.map((error) => error.code), ["MXL_UNSAFE", "MXL_UNSAFE"]);
});

test("pins every vendored schema asset to its recorded upstream digest", async () => {
  // Given: the provenance manifest and each vendored XSD byte stream.
  const origin: unknown = JSON.parse(await readFile(join(process.cwd(), "vendor", "musicxml-4.0", "ORIGIN.json"), "utf8"));
  assertOrigin(origin);

  // When: every current schema digest is calculated independently.
  const actual = Object.fromEntries(await Promise.all(Object.keys(origin.files).map(async (name) => {
    const bytes = await readFile(join(process.cwd(), "vendor", "musicxml-4.0", name));
    return [name, createHash("sha256").update(bytes).digest("hex")];
  })));

  // Then: the pinned commit and all digests exactly match the provenance record.
  assert.equal(origin.commit, "799e2defb2ece0ae7bafe08dcbcac25b2c631d53");
  assert.deepEqual(actual, origin.files);
});

async function fixture(name: string): Promise<Uint8Array> {
  return readFile(join(FIXTURES, name));
}

function containerXml(...paths: readonly string[]): Uint8Array {
  return strToU8(`<?xml version="1.0"?><container><rootfiles>${paths.map((path) => `<rootfile full-path="${path}" media-type="application/vnd.recordare.musicxml+xml"/>`).join("")}</rootfiles></container>`);
}

function mxl(score: Uint8Array, additions: Zippable = {}, container = containerXml("score.musicxml")): Uint8Array {
  return zipSync({ "META-INF/container.xml": container, "score.musicxml": score, ...additions }, { level: 6, mtime: new Date("1980-01-01T00:00:00.000Z") });
}

function duplicateContainer(score: Uint8Array): Uint8Array {
  const archive = mxl(score, { "META-INF/containex.xml": containerXml("score.musicxml") });
  return replaceAscii(archive, "META-INF/containex.xml", "META-INF/container.xml");
}

function tooManyEntries(score: Uint8Array): Uint8Array {
  const additions: Zippable = {};
  for (let index = 0; index < 127; index += 1) additions[`safe-${index}.bin`] = new Uint8Array([index]);
  return mxl(score, additions);
}

function mutateEncrypted(archive: Uint8Array): Uint8Array {
  const copy = archive.slice();
  const view = dataView(copy);
  const central = centralOffset(view);
  view.setUint16(central + 8, view.getUint16(central + 8, true) | 1, true);
  return copy;
}

function prefixArchive(archive: Uint8Array, prefixLength: number): Uint8Array {
  const prefixed = new Uint8Array(prefixLength + archive.byteLength);
  prefixed.set(archive, prefixLength);
  const view = dataView(prefixed);
  const eocd = eocdOffset(view);
  const originalCentral = view.getUint32(eocd + 16, true);
  const central = originalCentral + prefixLength;
  const count = view.getUint16(eocd + 10, true);
  view.setUint32(eocd + 16, central, true);
  let entry = central;
  for (let index = 0; index < count; index += 1) {
    view.setUint32(entry + 42, view.getUint32(entry + 42, true) + prefixLength, true);
    entry += 46 + view.getUint16(entry + 28, true) + view.getUint16(entry + 30, true) + view.getUint16(entry + 32, true);
  }
  return prefixed;
}

function mutateDiskNumber(archive: Uint8Array): Uint8Array {
  const copy = archive.slice();
  dataView(copy).setUint16(eocdOffset(dataView(copy)) + 4, 1, true);
  return copy;
}

function mutateCentralSizes(archive: Uint8Array, entryIndex: number, compressed: number, uncompressed: number): Uint8Array {
  const copy = archive.slice();
  const view = dataView(copy);
  const entry = centralEntry(view, entryIndex);
  view.setUint32(entry + 20, compressed, true);
  view.setUint32(entry + 24, uncompressed, true);
  return copy;
}

function mutateNamedUncompressedSize(archive: Uint8Array, name: string, size: number): Uint8Array {
  const copy = archive.slice();
  const view = dataView(copy);
  const count = view.getUint16(eocdOffset(view) + 10, true);
  for (let index = 0; index < count; index += 1) {
    const offset = centralEntry(view, index);
    const length = view.getUint16(offset + 28, true);
    if (Buffer.from(copy.subarray(offset + 46, offset + 46 + length)).toString("utf8") === name) {
      view.setUint32(offset + 24, size, true);
      return copy;
    }
  }
  throw new Error(`Missing ZIP test entry: ${name}`);
}

function replaceAscii(archive: Uint8Array, before: string, after: string): Uint8Array {
  assert.equal(before.length, after.length);
  const copy = archive.slice();
  const source = Buffer.from(before);
  const replacement = Buffer.from(after);
  for (let offset = 0; offset <= copy.length - source.length; offset += 1) {
    if (source.every((byte, index) => copy[offset + index] === byte)) copy.set(replacement, offset);
  }
  return copy;
}

function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function eocdOffset(view: DataView): number {
  for (let offset = view.byteLength - 22; offset >= 0; offset -= 1) if (view.getUint32(offset, true) === 0x06054b50) return offset;
  throw new Error("Missing test EOCD");
}

function centralOffset(view: DataView): number {
  return view.getUint32(eocdOffset(view) + 16, true);
}

function centralEntry(view: DataView, index: number): number {
  let offset = centralOffset(view);
  for (let current = 0; current < index; current += 1) offset += 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  return offset;
}

async function captureMusicXmlError(xml: Uint8Array): Promise<MusicXmlValidationError> {
  return captureError(validateMusicXml(xml));
}

async function captureMxlError(archive: Uint8Array): Promise<MusicXmlValidationError> {
  return captureError(validateMxl(archive));
}

async function captureError(result: Promise<unknown>): Promise<MusicXmlValidationError> {
  try {
    await result;
  } catch (error) {
    if (error instanceof MusicXmlValidationError) return error;
    throw error;
  }
  throw new Error("Expected validation to fail");
}

async function startCanary(t: TestContext): Promise<{ readonly port: number; readonly requests: () => number }> {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(500).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => {
    if (error) reject(error);
    else {
      t.diagnostic(JSON.stringify({ scenario: "http-canary-cleanup", closed: true, requests: requestCount }));
      resolve();
    }
  })));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Canary did not bind an IP port");
  return { port: address.port, requests: () => requestCount };
}

function assertOrigin(value: unknown): asserts value is { readonly commit: string; readonly files: Record<string, string> } {
  if (typeof value !== "object" || value === null || !("commit" in value) || typeof value.commit !== "string" || !("files" in value) || typeof value.files !== "object" || value.files === null) {
    throw new Error("Invalid MusicXML schema provenance fixture");
  }
  for (const digest of Object.values(value.files)) if (typeof digest !== "string") throw new Error("Invalid MusicXML schema digest fixture");
}
