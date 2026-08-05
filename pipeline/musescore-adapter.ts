import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { unzipSync } from "fflate";
import { PDFDocument, PDFName } from "pdf-lib";
import { MusicXmlValidationError, validateMxl } from "./musicxml-validator";
import type { ScoreReviewDecisionInput } from "./score-review-contract";
import { resolveScoreRuntimeTarget, type ScoreRuntimeManifest } from "./score-runtime-manifest";
import { runScoreTool } from "./score-tool-runner";
import { inspectStructuredPdfPage } from "./structured-score-review";

const STYLE_SHA256 = "b53887aad75e77213253d66303bcc024eb2c645a99632eae87e5149b4a238458";
const A4 = { width: 595.2755905511812, height: 841.8897637795276, tolerance: 0.02 } as const;

export type MuseScorePageInput = {
  readonly pageNumber: number;
  readonly mxlPath: string;
  readonly sourceSystemCount: number;
  readonly sourceStaffGroupCount: number;
};

export type StructuredPageObservation = {
  readonly outputPageNumber: number;
  readonly systemCount: number;
  readonly staffGroupCount: number;
  readonly boundaryInk: boolean;
};

export type MuseScoreRenderedPage = MuseScorePageInput & StructuredPageObservation & {
  readonly pdfSha256: string;
};

export type MuseScoreRenderResult =
  | { readonly ok: true; readonly outputPath: string; readonly pages: readonly MuseScoreRenderedPage[] }
  | { readonly ok: false; readonly failures: readonly ScoreReviewDecisionInput[] };

export type MuseScoreRenderRequest = {
  readonly manifest: ScoreRuntimeManifest;
  readonly releaseTarget: string;
  readonly osVersion?: string;
  readonly bundleRoot: string;
  readonly assetRoot?: string;
  readonly expectedLelandFontSha256: string;
  readonly outputPath: string;
  readonly pages: readonly MuseScorePageInput[];
  readonly timeoutCeilingMs?: number;
  readonly signal?: AbortSignal;
};

export async function renderMuseScoreDocument(request: MuseScoreRenderRequest): Promise<MuseScoreRenderResult> {
  return renderDocument(request);
}

export async function renderMuseScoreDocumentForTesting(
  request: MuseScoreRenderRequest,
  inspect: (input: { readonly pageNumber: number; readonly pdf: Uint8Array; readonly derived: StructuredPageObservation }) => Promise<StructuredPageObservation>
): Promise<MuseScoreRenderResult> {
  return renderDocument(request, inspect);
}

async function renderDocument(
  request: MuseScoreRenderRequest,
  testInspect?: (input: { readonly pageNumber: number; readonly pdf: Uint8Array; readonly derived: StructuredPageObservation }) => Promise<StructuredPageObservation>
): Promise<MuseScoreRenderResult> {
  const lineageFailure = validateLineage(request.pages);
  if (lineageFailure !== null) return failed(lineageFailure);
  const platform = resolveScoreRuntimeTarget(request.manifest, request.releaseTarget, request.osVersion);
  const executable = resolve(request.bundleRoot, platform.runtimes.musescore.stagedExecutable);
  const stylePath = resolve(request.assetRoot ?? process.cwd(), "pipeline/assets/musescore-a4.mss");
  const leland = request.manifest.tools.musescore.fonts.find((font) => font.family === "Leland");
  if (leland === undefined) return failed(unavailable("font-manifest"));
  if (!await digestMatchesFile(stylePath, STYLE_SHA256)) return failed(unavailable("style-integrity"));
  if (!await digestMatchesDirectory(resolve(request.bundleRoot, leland.bundledPath), request.expectedLelandFontSha256)) return failed(unavailable("font-integrity"));

  const probe = await runScoreTool({ tool: "musescore", executable, args: ["--version"], pageCount: request.pages.length, timeoutCeilingMs: request.timeoutCeilingMs, signal: request.signal });
  if (!probe.ok) return failed(toolFailure(probe.code, probe.exitCode, probe.stderr, request.timeoutCeilingMs));
  if (probe.stdoutTruncated || probe.stderrTruncated || probe.stderr.trim() !== "" || (!/^MuseScore(?: Studio)? 4\.7\.4(?:\s.*)?$/u.test(probe.stdout.trim()) && probe.stdout.trim() !== "4.7.4")) {
    return failed(unavailable(probe.stdout.trim() || "missing-version"));
  }

  const rendered: Array<{ readonly input: MuseScorePageInput; readonly pdf: Uint8Array; readonly observation: StructuredPageObservation }> = [];
  for (const page of request.pages) {
    const validated = await validateInput(page);
    if (validated !== null) return failed(validated);
    const result = await runScoreTool({
      tool: "musescore",
      executable,
      args: ["-platform", "offscreen", "-S", stylePath, "-o", `page-${String(page.pageNumber).padStart(4, "0")}.pdf`, resolve(page.mxlPath)],
      pageCount: request.pages.length,
      timeoutCeilingMs: request.timeoutCeilingMs,
      signal: request.signal,
      collect: async (workspace) => validatePdf(await readFile(join(workspace.work, `page-${String(page.pageNumber).padStart(4, "0")}.pdf`)))
    });
    if (!result.ok) {
      if (result.code === "SCORE_TOOL_COLLECTION_FAILED") return failed(pdfFailure(page.pageNumber, result.stderr || "invalid-output"));
      return failed(toolFailure(result.code, result.exitCode, result.stderr, request.timeoutCeilingMs, page.pageNumber));
    }
    if (!(result.value instanceof Uint8Array)) return failed(pdfFailure(page.pageNumber, "missing-output"));
    let observation: StructuredPageObservation;
    try {
      const derived = await inspectStructuredPdfPage(page.pageNumber, result.value);
      observation = testInspect === undefined ? derived : await testInspect({ pageNumber: page.pageNumber, pdf: result.value, derived });
    } catch (error) {
      return failed(pdfFailure(page.pageNumber, `inspection: ${errorText(error)}`));
    }
    rendered.push({ input: page, pdf: result.value, observation });
  }

  const document = await PDFDocument.create();
  for (const page of rendered) {
    const source = await PDFDocument.load(page.pdf, { updateMetadata: false });
    const copied = await document.copyPages(source, [0]);
    const first = copied[0];
    if (first === undefined) return failed(pdfFailure(page.input.pageNumber, "missing-page"));
    document.addPage(first);
  }
  const bytes = await document.save({ useObjectStreams: false });
  await mkdir(dirname(request.outputPath), { recursive: true });
  const temporary = `${request.outputPath}.tmp-${process.pid}`;
  await writeFile(temporary, bytes);
  await rename(temporary, request.outputPath);
  return {
    ok: true,
    outputPath: request.outputPath,
    pages: rendered.map(({ input, pdf, observation }) => ({ ...input, ...observation, pdfSha256: sha256(pdf) }))
  };
}

async function validateInput(page: MuseScorePageInput): Promise<ScoreReviewDecisionInput | null> {
  try {
    const archive = await readFile(page.mxlPath);
    await validateMxl(archive);
    if (!hasMinimumStructure(archive)) return { pageNumber: page.pageNumber, code: "MUSICXML_INVALID", evidence: { validationReason: "minimum-structure" } };
    return null;
  } catch (error) {
    if (error instanceof MusicXmlValidationError) {
      return error.code === "MXL_UNSAFE"
        ? { pageNumber: page.pageNumber, code: "MXL_UNSAFE", evidence: { reason: error.reason } }
        : { pageNumber: page.pageNumber, code: "MUSICXML_INVALID", evidence: { validationReason: error.reason } };
    }
    if (isFileAccessError(error)) return { pageNumber: page.pageNumber, code: "MXL_UNSAFE", evidence: { reason: "input-unavailable" } };
    throw error;
  }
}

function hasMinimumStructure(archive: Uint8Array): boolean {
  const files = unzipSync(archive);
  const container = files["META-INF/container.xml"];
  if (container === undefined) return false;
  const match = /<rootfile\b[^>]*\bfull-path=["']([^"']+)["']/u.exec(Buffer.from(container).toString("utf8"));
  const path = match?.[1];
  const score = path === undefined ? undefined : files[path.replaceAll("&amp;", "&")];
  if (score === undefined) return false;
  const xml = Buffer.from(score).toString("utf8");
  const hasPart = /<score-part\b/u.test(xml) && /<part(?:\s|>)/u.test(xml);
  const hasStaff = /<staff(?:\s|>)/u.test(xml) || /<staves>\s*[1-9]\d*\s*<\/staves>/u.test(xml) || !/<staves(?:\s|>)/u.test(xml);
  return hasPart && hasStaff && /<measure(?:\s|>)/u.test(xml) && /<note(?:\s|>)/u.test(xml);
}

async function validatePdf(bytes: Uint8Array): Promise<Uint8Array> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  if (document.getPageCount() !== 1) throw new TypeError("page-count");
  const page = document.getPage(0);
  const boxes = [page.getMediaBox(), page.getCropBox(), page.getTrimBox(), page.getBleedBox(), page.getArtBox()];
  if (page.node.get(PDFName.of("MediaBox")) === undefined || page.getRotation().angle !== 0 || boxes.some((box) => !close(box.x, 0) || !close(box.y, 0) || !close(box.width, A4.width) || !close(box.height, A4.height))) {
    throw new TypeError("page-box");
  }
  return bytes;
}

function validateLineage(pages: readonly MuseScorePageInput[]): ScoreReviewDecisionInput | null {
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    if (page === undefined || page.pageNumber !== index + 1) return { pageNumber: page?.pageNumber ?? null, code: "STRUCTURED_LINEAGE_MISMATCH", evidence: { expectedPageNumber: index + 1, actualPageNumber: page?.pageNumber ?? -1 } };
  }
  return pages.length === 0 ? { pageNumber: null, code: "MUSICXML_INVALID", evidence: { validationReason: "empty-document" } } : null;
}

function toolFailure(code: string, exitCode: number | null, stderr: string, timeoutMs = 0, pageNumber: number | null = null): ScoreReviewDecisionInput {
  if (code === "SCORE_TOOL_TIMED_OUT" || code === "SCORE_TOOL_CANCELLED") return { pageNumber, code: "ENGRAVER_TIMEOUT", evidence: { timeoutMs } };
  return { pageNumber, code: "ENGRAVER_FAILED", evidence: { exitCode: exitCode ?? -1, logSummary: stderr.slice(0, 240) || code } };
}

function unavailable(versionProbe: string): ScoreReviewDecisionInput { return { pageNumber: null, code: "ENGRAVER_UNAVAILABLE", evidence: { tool: "musescore", versionProbe } }; }
function pdfFailure(pageNumber: number, validationReason: string): ScoreReviewDecisionInput { return { pageNumber, code: "STRUCTURED_PDF_INVALID", evidence: { validationReason } }; }
function failed(failure: ScoreReviewDecisionInput): MuseScoreRenderResult { return { ok: false, failures: [failure] }; }
function close(actual: number, expected: number): boolean { return Math.abs(actual - expected) <= A4.tolerance; }
function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

async function digestMatchesFile(path: string, expected: string): Promise<boolean> {
  try { return sha256(await readFile(path)) === expected; } catch (error) {
    if (isFileAccessError(error)) return false;
    throw error;
  }
}

async function digestMatchesDirectory(root: string, expected: string): Promise<boolean> {
  try {
    const files = await directoryFiles(root);
    const hash = createHash("sha256");
    for (const path of files) hash.update(relative(root, path).split(sep).join("/")).update("\0").update(await readFile(path));
    return files.length > 0 && hash.digest("hex") === expected;
  } catch (error) {
    if (isFileAccessError(error) || error instanceof TypeError) return false;
    throw error;
  }
}

function isFileAccessError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EACCES");
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

async function directoryFiles(root: string): Promise<readonly string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(root, entry.name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new TypeError("font-symlink");
    if (stat.isDirectory()) files.push(...await directoryFiles(path));
    else if (stat.isFile()) files.push(path);
  }
  return files.sort();
}
