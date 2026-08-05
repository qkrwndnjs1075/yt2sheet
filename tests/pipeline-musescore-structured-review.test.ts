import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { zipSync } from "fflate";
import { PDFDocument, type PDFPage } from "pdf-lib";
import { loadScoreRuntimeManifest, resolveScoreRuntimeTarget } from "../pipeline/score-runtime-manifest.js";
import { renderMuseScoreDocument, renderMuseScoreDocumentForTesting } from "../pipeline/musescore-adapter.js";
import { reviewStructuredScore } from "../pipeline/structured-score-review.js";

const A4 = { width: 595.2755905511812, height: 841.8897637795276 } as const;

test("two safe MXL pages render with pinned MuseScore settings and select one structured document", async (t) => {
  // Given: a manifest-shaped staged runtime, pinned style/font bytes, and two ordered score pages.
  const fixture = await createFixture(t);

  // When: both pages render and their raster observations remain within every conservative bound.
  const rendered = await renderMuseScoreDocument(fixture.request());
  const selected = reviewStructuredScore({ pageCount: 2, rasterPdfPath: fixture.rasterPdf, render: rendered });

  // Then: one ordered structured document is selected and the converter receipt locks argv/environment behavior.
  assert.equal(rendered.ok, true, JSON.stringify(rendered));
  assert.equal(selected.review.disposition, "structured");
  assert.equal(selected.selectedPdfPath, fixture.structuredPdf);
  assert.deepEqual(await fixture.calls(), [
    ["--version"],
    ["-platform", "offscreen", "-S", fixture.style, "-o", "page-0001.pdf", fixture.mxl(1)],
    ["-platform", "offscreen", "-S", fixture.style, "-o", "page-0002.pdf", fixture.mxl(2)]
  ]);
  assert.equal(createHash("sha256").update(await readFile(fixture.style)).digest("hex"), "b53887aad75e77213253d66303bcc024eb2c645a99632eae87e5149b4a238458");
  for (const environment of await fixture.environments()) {
    assert.match(environment.home, /yt2sheet-score-tool-/u);
    assert.equal(environment.home, environment.userProfile);
    assert.equal(environment.home, environment.config);
    assert.notEqual(environment.home, environment.cache);
    assert.notEqual(environment.home, environment.temporary);
  }
  const pdf = await PDFDocument.load(await readFile(fixture.structuredPdf), { updateMetadata: false });
  assert.equal(pdf.getPageCount(), 2);
  assert.deepEqual(pdf.getPages().map((page) => [page.getWidth(), page.getHeight()]), [[A4.width, A4.height], [A4.width, A4.height]]);
  const evidenceDirectory = process.env["YT2SHEET_MUSESCORE_EVIDENCE_DIR"];
  if (evidenceDirectory !== undefined) await Promise.all([copyFile(fixture.structuredPdf, join(evidenceDirectory, "qa-structured.pdf")), copyFile(fixture.rasterPdf, join(evidenceDirectory, "qa-raster.pdf"))]);
});

test("every page, tool, artifact, and comparison failure selects the untouched whole raster document", async (t) => {
  // Given: independently corruptible two-page structured fixtures and one immutable raster fallback.
  const cases = [
    "corrupt-mxl", "style", "font", "non-a4", "empty-measures", "reorder", "system-delta-2",
    "staff-ratio-079", "staff-ratio-126", "boundary-ink", "blank-pdf", "corrupt-pdf", "inspection-failed", "timeout", "cancelled", "nonzero", "wrong-version", "conflicting-stderr", "truncated-stderr"
  ] as const;

  for (const name of cases) await t.test(name, async (inner) => {
    const fixture = await createFixture(inner, name);
    const rasterBefore = createHash("sha256").update(await readFile(fixture.rasterPdf)).digest("hex");

    // When: one structured-page precondition, conversion, PDF, order, or comparison contract fails.
    const rendered = await fixture.render();
    const selected = reviewStructuredScore({ pageCount: 2, rasterPdfPath: fixture.rasterPdf, render: rendered });

    // Then: no structured page is patched in and the original raster bytes are selected unchanged.
    assert.equal(selected.review.disposition, "raster-fallback");
    assert.equal(selected.selectedPdfPath, fixture.rasterPdf);
    assert.equal(createHash("sha256").update(await readFile(fixture.rasterPdf)).digest("hex"), rasterBefore);
    if (rendered.ok) {
      assert.notEqual(fixture.structuredPdf, selected.selectedPdfPath);
      assert.ok((await readFile(fixture.structuredPdf)).byteLength > 0, "rejected structured candidate remains separate from selection");
    } else {
      await assert.rejects(readFile(fixture.structuredPdf));
    }
    const expectedCode = expectedFailureCode(name);
    assert.ok(selected.review.decisions.some((decision) => decision.code === expectedCode), `${name} must report ${expectedCode}`);
  });
});

test("comparison bounds include delta one and staff ratios 0.80 through 1.25", () => {
  // Given: two rendered pages exactly on the lower and upper structured comparison limits.
  const render = {
    ok: true,
    outputPath: "/structured.pdf",
    pages: [
      renderedPage(1, 5, 80),
      renderedPage(2, 3, 125)
    ]
  } as const;

  // When: the whole document is conservatively reviewed.
  const selection = reviewStructuredScore({ pageCount: 2, rasterPdfPath: "/raster.pdf", render });

  // Then: both inclusive limits remain eligible for structured selection.
  assert.equal(selection.review.disposition, "structured");
  assert.equal(selection.selectedPdfPath, "/structured.pdf");
});

type FailureCase = "corrupt-mxl" | "style" | "font" | "non-a4" | "empty-measures" | "reorder" | "system-delta-2" | "staff-ratio-079" | "staff-ratio-126" | "boundary-ink" | "blank-pdf" | "corrupt-pdf" | "inspection-failed" | "timeout" | "cancelled" | "nonzero" | "wrong-version" | "conflicting-stderr" | "truncated-stderr";

async function createFixture(t: TestContext, failure?: FailureCase): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "yt2sheet-musescore-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = await loadScoreRuntimeManifest();
  const platform = resolveScoreRuntimeTarget(manifest, "darwin-arm64");
  const executable = join(root, platform.runtimes.musescore.stagedExecutable);
  const leland = join(root, manifest.tools.musescore.fonts.find((font) => font.family === "Leland")?.bundledPath ?? "missing-leland", "Leland.otf");
  const assetRoot = join(root, "assets");
  const style = join(assetRoot, "pipeline", "assets", "musescore-a4.mss");
  const callsPath = join(root, "calls.jsonl");
  await Promise.all([mkdir(join(executable, ".."), { recursive: true }), mkdir(join(leland, ".."), { recursive: true }), mkdir(join(style, ".."), { recursive: true })]);
  await writeFile(leland, failure === "font" ? "corrupt" : "pinned-leland");
  await copyFile(join(process.cwd(), "pipeline", "assets", "musescore-a4.mss"), style);
  if (failure === "style") await writeFile(style, `${await readFile(style, "utf8")}<!-- stale -->`);
  await writeFakeConverter(executable, callsPath, failure);
  for (const page of [1, 2] as const) {
    const xml = musicXml(failure === "empty-measures" && page === 2);
    await writeFile(join(root, `page-${page}.mxl`), failure === "corrupt-mxl" && page === 2 ? Buffer.from("bad-mxl") : mxl(xml));
  }
  await writePdf(join(root, "raster.pdf"), A4.width, A4.height, 2);
  return new Fixture(root, assetRoot, style, executable, leland, callsPath, manifest, failure);
}

class Fixture {
  readonly rasterPdf: string;
  readonly structuredPdf: string;
  readonly style: string;

  constructor(
    readonly root: string,
    readonly assetRoot: string,
    style: string,
    readonly executable: string,
    readonly leland: string,
    readonly callsPath: string,
    readonly manifest: Awaited<ReturnType<typeof loadScoreRuntimeManifest>>,
    readonly failure?: FailureCase
  ) {
    this.rasterPdf = join(root, "raster.pdf");
    this.structuredPdf = join(root, "structured.pdf");
    this.style = style;
  }

  mxl(page: number): string { return join(this.root, `page-${page}.mxl`); }

  request(): Parameters<typeof renderMuseScoreDocument>[0] {
    const fontHash = createHash("sha256").update("Leland.otf").update("\0").update("pinned-leland").digest("hex");
    const controller = new AbortController();
    if (this.failure === "cancelled") controller.abort();
    return {
      manifest: this.manifest,
      releaseTarget: "darwin-arm64",
      bundleRoot: this.root,
      assetRoot: this.assetRoot,
      expectedLelandFontSha256: fontHash,
      outputPath: this.structuredPdf,
      timeoutCeilingMs: this.failure === "timeout" ? 100 : 5_000,
      signal: controller.signal,
      pages: [1, 2].map((pageNumber) => ({ pageNumber, mxlPath: this.mxl(pageNumber), sourceSystemCount: 4, sourceStaffGroupCount: this.failure === "staff-ratio-079" || this.failure === "staff-ratio-126" ? 100 : 8 }))
    };
  }

  render(): ReturnType<typeof renderMuseScoreDocument> {
    return renderMuseScoreDocumentForTesting(this.request(), async ({ pageNumber, derived }) => {
        if (this.failure === "inspection-failed" && pageNumber === 2) throw new TypeError("rasterizer-failed");
        return {
          outputPageNumber: this.failure === "reorder" ? 3 - pageNumber : pageNumber,
          systemCount: this.failure === "system-delta-2" && pageNumber === 2 ? 6 : 4,
          staffGroupCount: this.failure === "staff-ratio-079" && pageNumber === 2 ? 79 : this.failure === "staff-ratio-126" && pageNumber === 2 ? 126 : derived.staffGroupCount,
          boundaryInk: this.failure === "boundary-ink" && pageNumber === 2 ? true : derived.boundaryInk
        };
      });
  }

  async calls(): Promise<readonly (readonly string[])[]> {
    const source = await readFile(this.callsPath, "utf8");
    return source.trim().split("\n").filter(Boolean).map((line) => receipt(line).args);
  }

  async environments(): Promise<readonly EnvironmentReceipt[]> {
    const source = await readFile(this.callsPath, "utf8");
    return source.trim().split("\n").filter(Boolean).map((line) => receipt(line).environment);
  }
}

async function writeFakeConverter(path: string, callsPath: string, failure?: FailureCase): Promise<void> {
  const script = `#!${process.execPath}
const fs=require("node:fs"), path=require("node:path"); const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({args,environment:{home:process.env.HOME,userProfile:process.env.USERPROFILE,config:process.env.XDG_CONFIG_HOME,cache:process.env.XDG_CACHE_HOME,temporary:process.env.TMPDIR}})+"\\n");
if(args[0]==="--version"){ console.log(${JSON.stringify(failure === "wrong-version" ? "MuseScore Studio 4.7.3" : "MuseScore Studio 4.7.4")}); if(${JSON.stringify(failure === "conflicting-stderr")}) console.error("MuseScore Studio 4.7.3"); if(${JSON.stringify(failure === "truncated-stderr")}) process.stderr.write("x".repeat(2*1024*1024+1)); process.exit(0); }
const output=args[args.indexOf("-o")+1], input=args[args.length-1];
if(${JSON.stringify(failure === "timeout")} && input.endsWith("page-2.mxl")) setInterval(()=>{},1000);
else if(${JSON.stringify(failure === "nonzero")} && input.endsWith("page-2.mxl")){ console.log("success"); process.exit(7); }
else if(${JSON.stringify(failure === "corrupt-pdf")} && input.endsWith("page-2.mxl")) fs.writeFileSync(output,"not-a-pdf");
else { fs.copyFileSync(path.join(${JSON.stringify(path + ".templates")}, ${JSON.stringify(failure === "non-a4" ? "letter.pdf" : failure === "blank-pdf" ? "blank.pdf" : "a4.pdf")}), output); }
`;
  await writeFile(path, script);
  await chmod(path, 0o755);
  await mkdir(path + ".templates", { recursive: true });
  await writePdf(join(path + ".templates", "a4.pdf"), A4.width, A4.height, 1, true);
  await writePdf(join(path + ".templates", "letter.pdf"), 612, 792, 1, true);
  await writePdf(join(path + ".templates", "blank.pdf"), A4.width, A4.height, 1);
}

async function writePdf(path: string, width: number, height: number, pages: number, notation = false): Promise<void> {
  const pdf = await PDFDocument.create();
  for (let page = 0; page < pages; page += 1) {
    const output = pdf.addPage([width, height]);
    if (notation) drawStaffFixture(output);
  }
  await writeFile(path, await pdf.save({ useObjectStreams: false }));
}

function musicXml(empty: boolean): Uint8Array {
  const note = empty ? "" : "<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>";
  return Buffer.from(`<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><staves>1</staves><clef><sign>G</sign><line>2</line></clef></attributes>${note}</measure></part></score-partwise>`);
}

function mxl(xml: Uint8Array): Uint8Array {
  return zipSync({ "META-INF/container.xml": Buffer.from('<?xml version="1.0"?><container><rootfiles><rootfile full-path="score.musicxml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>'), "score.musicxml": xml }, { level: 6, mtime: new Date("1980-01-01T00:00:00.000Z") });
}

function expectedFailureCode(name: FailureCase): string {
  if (name === "corrupt-mxl") return "MXL_UNSAFE";
  if (name === "empty-measures") return "MUSICXML_INVALID";
  if (name === "style" || name === "font" || name === "wrong-version" || name === "conflicting-stderr" || name === "truncated-stderr") return "ENGRAVER_UNAVAILABLE";
  if (name === "timeout" || name === "cancelled") return "ENGRAVER_TIMEOUT";
  if (name === "nonzero") return "ENGRAVER_FAILED";
  if (name === "reorder") return "STRUCTURED_LINEAGE_MISMATCH";
  return "STRUCTURED_PDF_INVALID";
}

function drawStaffFixture(page: PDFPage): void {
  for (let system = 0; system < 4; system += 1) {
    for (let staff = 0; staff < 2; staff += 1) {
      const top = 760 - system * 150 - staff * 30;
      for (let line = 0; line < 5; line += 1) page.drawLine({ start: { x: 60, y: top - line * 4 }, end: { x: 535, y: top - line * 4 }, thickness: 0.7 });
    }
  }
}

function renderedPage(pageNumber: number, systemCount: number, staffGroupCount: number) {
  return {
    pageNumber,
    outputPageNumber: pageNumber,
    mxlPath: `/page-${pageNumber}.mxl`,
    sourceSystemCount: 4,
    systemCount,
    sourceStaffGroupCount: 100,
    staffGroupCount,
    boundaryInk: false,
    pdfSha256: "a".repeat(64)
  };
}

type EnvironmentReceipt = { readonly home: string; readonly userProfile: string; readonly config: string; readonly cache: string; readonly temporary: string };

function receipt(line: string): { readonly args: readonly string[]; readonly environment: EnvironmentReceipt } {
  const value: unknown = JSON.parse(line);
  assert.ok(typeof value === "object" && value !== null && "args" in value && "environment" in value);
  const args = value.args;
  const environment = value.environment;
  assert.ok(Array.isArray(args) && args.every((item) => typeof item === "string"));
  assert.ok(typeof environment === "object" && environment !== null);
  return {
    args: args.filter((item): item is string => typeof item === "string"),
    environment: {
      home: environmentField(environment, "home"),
      userProfile: environmentField(environment, "userProfile"),
      config: environmentField(environment, "config"),
      cache: environmentField(environment, "cache"),
      temporary: environmentField(environment, "temporary")
    }
  };
}

function environmentField(environment: object, field: string): string {
  assert.ok(field in environment);
  const value = Reflect.get(environment, field);
  assert.equal(typeof value, "string");
  return typeof value === "string" ? value : "";
}
