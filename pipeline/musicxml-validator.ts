import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { inflateSync } from "fflate";
import type * as LibXml from "libxml2-wasm";

const LIMITS = {
  entries: 128,
  compressed: 64 * 1024 * 1024,
  xml: 32 * 1024 * 1024,
  uncompressed: 256 * 1024 * 1024,
  ratio: 100
} as const;
const SCHEMA_ROOTS = [
  join(process.cwd(), "vendor", "musicxml-4.0"),
  ...(typeof __dirname === "string" ? [join(__dirname, "..", "..", "vendor", "musicxml-4.0")] : [])
] as const;
const SCHEMA_URL = "http://www.musicxml.org/xsd/musicxml.xsd";
const CONTAINER_SCHEMA_URL = "http://www.musicxml.org/xsd/container.xsd";
const SCHEMA_HASHES = {
  "container.xsd": "deddcc2f51e856de21397bbe25e2cf304ca9e3253b0d25dcc6349c390bc22fa6",
  "musicxml.xsd": "bfe37ed25a9ec00e6f2591d53df260b84efe12aed209ba3ac0a76f9287665a99",
  "opus.xsd": "e8256607b9255075f16c1d70ed53f8384ab6e3b9dc4c1f81291cdd1d56b0474a",
  "sounds.xsd": "a3a423bcdf9f385f74d6bdf6024f7a29e70c4745de4825d33327f903124533e1",
  "xlink.xsd": "6e601f8eeb41618b50e4c7f944dff754e57ea43b602755470dda24c9c2f6df92",
  "xml.xsd": "616a3077df5cfc954ac74a75abe9697b95eef7a85dbe09367d995a483e840eb5"
} as const;
const PARSE_SAFELY = 8_388_608 | 2_048 | 33_554_432;
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export type MusicXmlValidationResult = {
  readonly format: "musicxml" | "mxl";
  readonly root: "score-partwise" | "score-timewise";
};

export class MusicXmlValidationError extends Error {
  readonly code: "MXL_UNSAFE" | "MUSICXML_INVALID";
  readonly reason: string;

  constructor(code: "MXL_UNSAFE" | "MUSICXML_INVALID", reason: string) {
    super(`${code}: ${reason}`);
    this.name = "MusicXmlValidationError";
    this.code = code;
    this.reason = reason;
  }
}

type ZipEntry = {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly crc: number;
  readonly localOffset: number;
};

let validationTail: Promise<void> = Promise.resolve();

export function validateMusicXml(xml: Uint8Array): Promise<MusicXmlValidationResult> {
  return exclusively(() => validateXml(xml, "musicxml"));
}

export function validateMxl(archive: Uint8Array): Promise<MusicXmlValidationResult> {
  return exclusively(async () => {
    const entries = inspectZip(archive);
    const containers = entries.filter((entry) => entry.name === "META-INF/container.xml");
    unsafeUnless(containers.length === 1, "container-count");
    const container = extractEntry(archive, required(containers[0], "container-count"));
    const containerPath = await readRootfile(container);
    const roots = entries.filter((entry) => entry.name === containerPath);
    unsafeUnless(roots.length === 1, "rootfile-count");
    const root = required(roots[0], "rootfile-count");
    unsafeUnless(root.uncompressedSize <= LIMITS.xml, "xml-size");
    const validated = await validateXml(extractEntry(archive, root), "mxl");
    return validated;
  });
}

async function validateXml(xml: Uint8Array, format: "musicxml" | "mxl"): Promise<MusicXmlValidationResult> {
  invalidUnless(xml.byteLength <= LIMITS.xml, format === "mxl" ? "MXL_UNSAFE" : "MUSICXML_INVALID", "xml-size");
  rejectDoctype(xml, format);
  const lib = await loadLibXml();
  const schemas = await loadSchemas();
  const provider = new BlockingSchemaProvider(lib, schemas);
  lib.xmlRegisterInputProvider(provider);
  let schemaDocument: LibXml.XmlDocument | undefined;
  let document: LibXml.XmlDocument | undefined;
  let validator: LibXml.XsdValidator | undefined;
  try {
    schemaDocument = lib.XmlDocument.fromBuffer(schemas[SCHEMA_URL], { url: SCHEMA_URL, option: PARSE_SAFELY });
    validator = lib.XsdValidator.fromDoc(schemaDocument);
    document = lib.XmlDocument.fromBuffer(xml, { option: PARSE_SAFELY });
    validator.validate(document);
    if (document.eval("string(/*/@version)") !== "4.0") throw invalidError(format, "version");
    const root = document.root.name;
    if (root !== "score-partwise" && root !== "score-timewise") throw invalidError(format, "unsupported-root");
    return { format, root };
  } catch (error) {
    if (error instanceof MusicXmlValidationError) throw error;
    if (error instanceof Error) throw invalidError(format, "schema-validation", error);
    throw error;
  } finally {
    document?.dispose();
    validator?.dispose();
    schemaDocument?.dispose();
    lib.xmlCleanupInputProvider();
  }
}

async function readRootfile(containerXml: Uint8Array): Promise<string> {
  rejectDoctype(containerXml, "mxl");
  const lib = await loadLibXml();
  const schemas = await loadSchemas();
  const provider = new BlockingSchemaProvider(lib, schemas);
  lib.xmlRegisterInputProvider(provider);
  let schemaDocument: LibXml.XmlDocument | undefined;
  let document: LibXml.XmlDocument | undefined;
  let validator: LibXml.XsdValidator | undefined;
  try {
    schemaDocument = lib.XmlDocument.fromBuffer(schemas[CONTAINER_SCHEMA_URL], { url: CONTAINER_SCHEMA_URL, option: PARSE_SAFELY });
    validator = lib.XsdValidator.fromDoc(schemaDocument);
    document = lib.XmlDocument.fromBuffer(containerXml, { option: PARSE_SAFELY });
    validator.validate(document);
    unsafeUnless(document.eval("count(/container/rootfiles/rootfile)") === 1, "rootfile-count");
    const mediaType = document.eval("string(/container/rootfiles/rootfile/@media-type)");
    unsafeUnless(mediaType === "" || mediaType === "application/vnd.recordare.musicxml+xml", "rootfile-media-type");
    const path = document.eval("string(/container/rootfiles/rootfile/@full-path)");
    unsafeUnless(typeof path === "string" && safePath(path) === path, "rootfile-path");
    return path;
  } catch (error) {
    if (error instanceof MusicXmlValidationError) throw error;
    if (error instanceof Error) throw new MusicXmlValidationError("MXL_UNSAFE", `container-invalid: ${error.message}`);
    throw error;
  } finally {
    document?.dispose();
    validator?.dispose();
    schemaDocument?.dispose();
    lib.xmlCleanupInputProvider();
  }
}

function inspectZip(data: Uint8Array): readonly ZipEntry[] {
  unsafeUnless(data.byteLength <= LIMITS.compressed, "compressed-size");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const eocd = findEocd(view);
  unsafeUnless(u16(view, eocd + 4) === 0 && u16(view, eocd + 6) === 0, "multi-disk");
  const count = u16(view, eocd + 10);
  unsafeUnless(count === u16(view, eocd + 8) && count <= LIMITS.entries, "entry-count");
  const centralSize = u32(view, eocd + 12);
  const centralOffset = u32(view, eocd + 16);
  unsafeUnless(centralOffset + centralSize <= eocd, "central-directory");
  const entries: ZipEntry[] = [];
  let offset = centralOffset;
  let totalCompressed = 0;
  let totalUncompressed = 0;
  for (let index = 0; index < count; index += 1) {
    unsafeUnless(u32(view, offset) === 0x02014b50, "central-entry");
    const flags = u16(view, offset + 8);
    const method = u16(view, offset + 10);
    const compressedSize = u32(view, offset + 20);
    const uncompressedSize = u32(view, offset + 24);
    const nameLength = u16(view, offset + 28);
    const extraLength = u16(view, offset + 30);
    const commentLength = u16(view, offset + 32);
    const localOffset = u32(view, offset + 42);
    unsafeUnless((flags & 0x41) === 0, "encrypted");
    unsafeUnless(method === 0 || method === 8, "compression-method");
    unsafeUnless(compressedSize !== 0xffffffff && uncompressedSize !== 0xffffffff && localOffset !== 0xffffffff, "zip64");
    const name = decodeName(data.subarray(offset + 46, offset + 46 + nameLength));
    unsafeUnless(safePath(name) === name, "entry-path");
    const unixMode = u32(view, offset + 38) >>> 16;
    unsafeUnless((unixMode & 0xf000) !== 0xa000, "symlink");
    unsafeUnless(uncompressedSize === 0 || compressedSize > 0, "compression-ratio");
    unsafeUnless(compressedSize === 0 || uncompressedSize / compressedSize <= LIMITS.ratio, "compression-ratio");
    if (name.toLowerCase().endsWith(".xml")) unsafeUnless(uncompressedSize <= LIMITS.xml, "xml-size");
    totalCompressed += compressedSize;
    totalUncompressed += uncompressedSize;
    entries.push({ name, method, compressedSize, uncompressedSize, crc: u32(view, offset + 16), localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  unsafeUnless(offset === centralOffset + centralSize, "central-directory");
  unsafeUnless(totalCompressed <= LIMITS.compressed, "compressed-size");
  unsafeUnless(totalUncompressed <= LIMITS.uncompressed, "uncompressed-size");
  unsafeUnless(new Set(entries.map((entry) => entry.name)).size === entries.length, "duplicate-entry");
  return entries;
}

function extractEntry(data: Uint8Array, entry: ZipEntry): Uint8Array {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  unsafeUnless(u32(view, entry.localOffset) === 0x04034b50, "local-entry");
  const flags = u16(view, entry.localOffset + 6);
  unsafeUnless((flags & 0x41) === 0 && u16(view, entry.localOffset + 8) === entry.method, "local-entry");
  const nameLength = u16(view, entry.localOffset + 26);
  const extraLength = u16(view, entry.localOffset + 28);
  const name = decodeName(data.subarray(entry.localOffset + 30, entry.localOffset + 30 + nameLength));
  unsafeUnless(name === entry.name, "local-name");
  const start = entry.localOffset + 30 + nameLength + extraLength;
  unsafeUnless(start + entry.compressedSize <= data.byteLength, "entry-bounds");
  const compressed = data.subarray(start, start + entry.compressedSize);
  const output = entry.method === 0 ? compressed.slice() : inflateSync(compressed, { out: new Uint8Array(entry.uncompressedSize) });
  unsafeUnless(output.byteLength === entry.uncompressedSize && crc32(output) === entry.crc, "entry-integrity");
  return output;
}

function findEocd(view: DataView): number {
  const minimum = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (u32(view, offset) === 0x06054b50 && offset + 22 + u16(view, offset + 20) === view.byteLength) return offset;
  }
  throw new MusicXmlValidationError("MXL_UNSAFE", "end-of-central-directory");
}

function safePath(path: string): string | undefined {
  if (!path || path.includes("\\") || path.includes("\0") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return undefined;
  const normalized = posix.normalize(path);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized !== path || path.endsWith("/")) return undefined;
  return normalized;
}

function rejectDoctype(xml: Uint8Array, format: "musicxml" | "mxl"): void {
  const ascii = Buffer.from(xml).toString("latin1").replaceAll("\0", "").toLowerCase();
  if (ascii.includes("<!doctype")) throw invalidError(format, "doctype");
  const resolutionMarkers = ["xsi:schemalocation", "xsi:nonamespaceschemalocation", "<xi:include", "<?xml-stylesheet"];
  if (resolutionMarkers.some((marker) => ascii.includes(marker))) throw invalidError(format, "external-reference");
}

function decodeName(bytes: Uint8Array): string {
  try { return textDecoder.decode(bytes); } catch (error) {
    if (error instanceof TypeError) throw new MusicXmlValidationError("MXL_UNSAFE", "filename-encoding");
    throw error;
  }
}

function u16(view: DataView, offset: number): number {
  unsafeUnless(offset >= 0 && offset + 2 <= view.byteLength, "archive-bounds");
  return view.getUint16(offset, true);
}

function u32(view: DataView, offset: number): number {
  unsafeUnless(offset >= 0 && offset + 4 <= view.byteLength, "archive-bounds");
  return view.getUint32(offset, true);
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function loadSchemas(): Promise<Record<string, Uint8Array>> {
  const names = ["musicxml.xsd", "container.xsd", "opus.xsd", "sounds.xsd", "xml.xsd", "xlink.xsd"] as const;
  for (const root of SCHEMA_ROOTS) {
    try {
      const values = await Promise.all(names.map((name) => readFile(join(root, name))));
      for (const [index, name] of names.entries()) {
        const value = required(values[index], "schema-asset");
        invalidUnless(createHash("sha256").update(value).digest("hex") === SCHEMA_HASHES[name], "MUSICXML_INVALID", "schema-asset-integrity");
      }
      return Object.fromEntries(names.map((name, index) => [`http://www.musicxml.org/xsd/${name}`, required(values[index], "schema-asset") ]));
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
  }
  throw new MusicXmlValidationError("MUSICXML_INVALID", "schema-asset-missing");
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

type LibXmlModule = typeof LibXml;

async function loadLibXml(): Promise<LibXmlModule> {
  const loaded: unknown = await eval('import("libxml2-wasm")');
  if (!isLibXmlModule(loaded)) throw new MusicXmlValidationError("MUSICXML_INVALID", "validator-runtime");
  return loaded;
}

function isLibXmlModule(value: unknown): value is LibXmlModule {
  return typeof value === "object" && value !== null && "XmlDocument" in value && "XsdValidator" in value && "xmlRegisterInputProvider" in value;
}

class BlockingSchemaProvider implements LibXml.XmlInputProvider {
  readonly delegate: LibXml.XmlBufferInputProvider;
  readonly allowed: ReadonlySet<string>;

  constructor(lib: LibXmlModule, schemas: Record<string, Uint8Array>) {
    this.delegate = new lib.XmlBufferInputProvider(schemas);
    this.allowed = new Set(Object.keys(schemas));
  }

  match(): boolean { return true; }
  open(filename: string): number | undefined { return this.allowed.has(filename) ? this.delegate.open(filename) : undefined; }
  read(fd: number, buffer: Uint8Array): number { return this.delegate.read(fd, buffer); }
  close(fd: number): boolean { return this.delegate.close(fd); }
}

function exclusively<T>(work: () => Promise<T>): Promise<T> {
  const result = validationTail.then(work, work);
  validationTail = result.then(() => undefined, () => undefined);
  return result;
}

function unsafeUnless(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new MusicXmlValidationError("MXL_UNSAFE", reason);
}

function invalidUnless(condition: boolean, code: "MXL_UNSAFE" | "MUSICXML_INVALID", reason: string): asserts condition {
  if (!condition) throw new MusicXmlValidationError(code, reason);
}

function invalidError(format: "musicxml" | "mxl", reason: string, cause?: Error): MusicXmlValidationError {
  return new MusicXmlValidationError(format === "mxl" ? "MXL_UNSAFE" : "MUSICXML_INVALID", cause ? `${reason}: ${cause.message}` : reason);
}

function required<T>(value: T | undefined, reason: string): T {
  unsafeUnless(value !== undefined, reason);
  return value;
}
