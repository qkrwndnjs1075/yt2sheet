#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

process.env.YT2SHEET_LOG_LEVEL = "silent";

const require = createRequire(import.meta.url);
const projectRoot = resolve(import.meta.dirname, "../..");
const compiledEntry = resolve(projectRoot, "dist-cli/cli/index.js");

function loadCompiledModules() {
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    return {
      ...require(compiledEntry),
      ...require(resolve(projectRoot, "dist-cli/cli/job.js")),
      ...require(resolve(projectRoot, "dist-cli/pipeline/youtube-score-processor.js")),
      ...require(resolve(projectRoot, "dist-cli/pipeline/score-video-processor.js")),
      ...require(resolve(projectRoot, "dist-cli/pipeline/score-raster-review.js"))
    };
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

const {
  main,
  runCliJob,
  YouTubeScoreProcessor,
  orchestrateReviewedScorePipeline,
  reviewRasterPageFiles
} = loadCompiledModules();
const { PDFDocument, PDFName } = require("pdf-lib");
const sharp = require("sharp");
const { strToU8, zipSync } = require("fflate");

const A4 = { width: 595.2755905511812, height: 841.8897637795276 };
const RASTER_WIDTH = 1200;
const RASTER_HEIGHT = 1697;
const VIDEO_ID = "dQw4w9WgXcQ";
const VIDEO_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
const FAKE_TOOLS = Object.freeze({ ytDlp: "qa-fake-yt-dlp", ffmpeg: "qa-fake-ffmpeg", ffprobe: "qa-fake-ffprobe", ytDlpJsRuntime: process.execPath });

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function createA4Pdf(marker) {
  const document = await PDFDocument.create();
  for (let pageNumber = 1; pageNumber <= 2; pageNumber += 1) {
    const page = document.addPage([A4.width, A4.height]);
    for (let staffLine = 0; staffLine < 5; staffLine += 1) {
      page.drawLine({
        start: { x: 70, y: 720 - staffLine * 10 },
        end: { x: 525, y: 720 - staffLine * 10 },
        thickness: 1
      });
    }
    page.drawText(`${marker}-${pageNumber}`, { x: 72, y: 760, size: 8 });
  }
  return Uint8Array.from(await document.save({ useObjectStreams: false }));
}

async function createReviewPagePng(pageNumber) {
  const rows = [];
  for (let group = 0; group < 8; group += 1) {
    const groupTop = 180 + group * 180 + (pageNumber - 1) * 4;
    for (let line = 0; line < 5; line += 1) {
      rows.push(`<line x1="120" x2="1080" y1="${groupTop + line * 18}" y2="${groupTop + line * 18}" stroke="black" stroke-width="3"/>`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${RASTER_WIDTH}" height="${RASTER_HEIGHT}" viewBox="0 0 ${RASTER_WIDTH} ${RASTER_HEIGHT}"><rect width="100%" height="100%" fill="white"/>${rows.join("")}</svg>`;
  return Uint8Array.from(await sharp(Buffer.from(svg)).png().toBuffer());
}

function validMxl(pageNumber) {
  const score = strToU8(`<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="${pageNumber}"><attributes><divisions>1</divisions><staves>1</staves></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><staff>1</staff></note></measure></part></score-partwise>`);
  return Uint8Array.from(zipSync({
    "META-INF/container.xml": strToU8('<?xml version="1.0"?><container><rootfiles><rootfile full-path="score.musicxml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>'),
    "score.musicxml": score
  }, { level: 6, mtime: new Date("1980-01-01T00:00:00.000Z") }));
}

function invalidMxl() {
  return Uint8Array.from(zipSync({
    "META-INF/container.xml": strToU8('<?xml version="1.0"?><container><rootfiles><rootfile full-path="score.musicxml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>'),
    "score.musicxml": strToU8('<score-partwise version="4.0"><part-list>')
  }, { level: 6, mtime: new Date("1980-01-01T00:00:00.000Z") }));
}

function makePages(pagePaths) {
  return pagePaths.map((path, index) => ({
    path,
    lineage: {
      pageNumber: index + 1,
      sourceFrameIds: [`frame-${String(index + 1).padStart(6, "0")}`],
      sourceScoreIds: [`score-${String(index + 1).padStart(4, "0")}`]
    },
    sourceSystemCount: 1,
    sourceStaffGroupCount: 1
  }));
}

function makeStages(mode, rasterBytes, structuredBytes, pagePngBytes, stageEvents) {
  return {
    async reviewRaster({ pages, signal }) {
      stageEvents.push("raster-review");
      return reviewRasterPageFiles(pages, signal);
    },
    async transcribe({ pages }) {
      stageEvents.push("audiveris");
      return {
        kind: "structured",
        pages: pages.map((page, index) => ({
          pageNumber: page.lineage.pageNumber,
          lineage: page.lineage,
          inputSha256: "a".repeat(64),
          outputSha256: "b".repeat(64),
          version: "5.11.0",
          durationMs: 1,
          exitCode: 0,
          logSummary: "local reviewed fixture",
          mxl: mode === "fallback" && index === 1 ? invalidMxl() : validMxl(page.lineage.pageNumber)
        }))
      };
    },
    async render({ pages, outputPath }) {
      stageEvents.push("musescore");
      await writeFile(outputPath, structuredBytes);
      return {
        ok: true,
        outputPath,
        pages: pages.map((page) => ({
          ...page,
          outputPageNumber: page.pageNumber,
          systemCount: 1,
          staffGroupCount: 1,
          boundaryInk: false,
          pdfSha256: "c".repeat(64)
        }))
      };
    },
    rasterBytes,
    structuredBytes,
    pagePngBytes
  };
}

async function runCase({ mode, root, rasterBytes, structuredBytes, pagePngBytes }) {
  const caseRoot = await mkdtemp(join(tmpdir(), `yt2sheet-compiled-reviewed-${mode}-`));
  const outputDirectory = join(caseRoot, "published");
  const outputPath = join(outputDirectory, `${mode}.pdf`);
  const stageEvents = [];
  const stages = makeStages(mode, rasterBytes, structuredBytes, pagePngBytes, stageEvents);
  const frameBytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: "white" } }).jpeg().toBuffer();
  const fakeVideoBytes = Buffer.from("local-fake-video");

  const processRunner = async (executable, args) => {
    if (executable === FAKE_TOOLS.ytDlp) {
      if (args.includes("--skip-download")) return "2\n";
      const outputIndex = args.indexOf("-o");
      const template = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
      assert.equal(typeof template, "string");
      const videoPath = template.replace("%(ext)s", "mp4");
      await writeFile(videoPath, fakeVideoBytes, { flag: "wx" });
      return `${videoPath}\n`;
    }
    if (executable === FAKE_TOOLS.ffprobe) return "2\n";
    if (executable === FAKE_TOOLS.ffmpeg) return "";
    throw new Error(`unexpected fake executable: ${executable}`);
  };

  const processorFactory = ({ dataRoot }) => new YouTubeScoreProcessor({
    dataRoot,
    tools: FAKE_TOOLS,
    processRunner,
    frameLister: async (frameDirectory) => {
      const paths = [1, 2].map((index) => join(frameDirectory, `frame-${String(index).padStart(6, "0")}.jpg`));
      await Promise.all(paths.map((path) => writeFile(path, frameBytes, { flag: "wx" })));
      return paths;
    },
    pdfCreator: async (_frames, workspace, outputPath, options) => {
      assert.ok(options.reviewedPipeline, "compiled processor must receive the reviewed pipeline seam");
      const rasterPdfPath = join(workspace, "reviewed-raster.pdf");
      const structuredPdfPath = join(workspace, "reviewed-structured.pdf");
      const pagePaths = [1, 2].map((index) => join(workspace, `page-${String(index).padStart(4, "0")}.png`));
      await Promise.all([
        writeFile(rasterPdfPath, rasterBytes, { flag: "wx" }),
        writeFile(pagePaths[0], pagePngBytes[0], { flag: "wx" }),
        writeFile(pagePaths[1], pagePngBytes[1], { flag: "wx" })
      ]);
      options.onProgress?.(75);
      options.onProgress?.(80);
      options.onProgress?.(85);
      const result = await orchestrateReviewedScorePipeline({
        rasterPdfPath,
        structuredPdfPath,
        outputPath,
        workspace,
        pages: makePages(pagePaths),
        stages: options.reviewedPipeline.stages,
        onStage: (stage) => {
          if (stage === "musescore") options.onProgress?.(90);
        }
      });
      options.onProgress?.(98);
      return { ...result, scoreCount: 2 };
    },
    reviewedPipelineFactory: async () => ({ stages })
  });

  const runJob = async (command) => runCliJob({
    ...command,
    tools: FAKE_TOOLS,
    toolValidator: async () => undefined,
    processorFactory
  });

  const stdout = [];
  const stderr = [];
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  process.stdout.write = (chunk) => {
    stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
  process.stderr.write = (chunk) => {
    stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };

  let exitCode;
  try {
    process.exitCode = undefined;
    await main([VIDEO_URL, "--output", outputPath], { runJob });
    exitCode = process.exitCode ?? 0;
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }

  const stdoutText = stdout.join("");
  const stderrText = stderr.join("");
  const outputBytes = await readFile(outputPath);
  const document = await PDFDocument.load(outputBytes, { updateMetadata: false });
  const pageBoxes = document.getPages().map((page) => ({
    mediaBox: page.getMediaBox(),
    cropBox: page.getCropBox(),
    trimBox: page.getTrimBox(),
    bleedBox: page.getBleedBox(),
    artBox: page.getArtBox(),
    explicitCropBox: page.node.get(PDFName.of("CropBox")) !== undefined,
    explicitTrimBox: page.node.get(PDFName.of("TrimBox")) !== undefined,
    explicitBleedBox: page.node.get(PDFName.of("BleedBox")) !== undefined,
    explicitArtBox: page.node.get(PDFName.of("ArtBox")) !== undefined
  }));
  const residue = (await readdir(outputDirectory)).sort();
  assert.equal(exitCode, 0, `${mode} should exit zero`);
  assert.equal(stdoutText, `${outputPath}\n`, `${mode} stdout must contain only the final PDF path`);
  assert.equal(document.getPageCount(), 2, `${mode} must publish two pages`);
  assert.deepEqual(residue, [`${mode}.pdf`], `${mode} output directory must not expose a sidecar or intermediate`);
  for (const box of pageBoxes) {
    assert.ok(Math.abs(box.mediaBox.width - A4.width) <= 0.02);
    assert.ok(Math.abs(box.mediaBox.height - A4.height) <= 0.02);
    assert.deepEqual(box.cropBox, box.mediaBox);
    assert.deepEqual(box.trimBox, box.mediaBox);
    assert.deepEqual(box.bleedBox, box.mediaBox);
    assert.deepEqual(box.artBox, box.mediaBox);
    assert.equal(box.explicitCropBox, false);
    assert.equal(box.explicitTrimBox, false);
    assert.equal(box.explicitBleedBox, false);
    assert.equal(box.explicitArtBox, false);
  }
  const expectedProgress = [
    "[1/9] info 0%", "[2/9] download 12%", "[3/9] extraction 32%", "[4/9] raster analysis 45%",
    "[5/9] raster review 75%", "[6/9] OMR 80%", "[7/9] MusicXML validation 85%", "[8/9] engraving 90%", "[9/9] PDF publication 100%"
  ];
  for (const line of expectedProgress) assert.ok(stderrText.includes(line), `${mode} stderr missing ${line}`);
  if (mode === "structured") {
    assert.equal(stderrText.includes("경고:"), false, "structured success must not emit a warning");
  } else {
    assert.equal(stderrText.match(/경고:/gu)?.length, 1, "fallback must emit one canonical warning");
    assert.ok(stderrText.includes("Unsafe MXL was rejected; using raster fallback."), stderrText);
    assert.equal(sha256(outputBytes), sha256(rasterBytes), "fallback must be byte-identical to the full raster candidate");
  }
  assert.deepEqual(stageEvents, ["raster-review", "audiveris", ...(mode === "structured" ? ["musescore"] : [])]);

  const artifact = {
    mode,
    compiledEntry: "dist-cli/cli/index.js",
    exitCode,
    stdout: stdoutText,
    stderr: stderrText,
    finalPdf: `${mode}.pdf`,
    finalPdfSha256: sha256(outputBytes),
    pageCount: document.getPageCount(),
    pageBoxes,
    outputResidue: residue,
    stageEvents,
    ...(mode === "fallback" ? { invalidMxlPage: 2, fallbackWarningCode: "MXL_UNSAFE" } : {}),
    fallbackByteIdenticalToRaster: mode === "fallback" ? sha256(outputBytes) === sha256(rasterBytes) : false,
    sidecarPatternsObserved: residue.filter((name) => /(?:quality|review|mxl|json)/iu.test(name)),
    cleanup: { caseRootRemoved: false }
  };
  const artifactDirectory = join(root, "compiled-reviewed-cli");
  await mkdir(artifactDirectory, { recursive: true });
  await rm(caseRoot, { recursive: true, force: true });
  artifact.cleanup.caseRootRemoved = !existsSync(caseRoot);
  await Promise.all([
    writeFile(join(artifactDirectory, `${mode}.stdout.txt`), stdoutText, "utf8"),
    writeFile(join(artifactDirectory, `${mode}.stderr.txt`), stderrText, "utf8"),
    writeFile(join(artifactDirectory, `${mode}.stream.json`), `${JSON.stringify(artifact, null, 2)}\n`, "utf8"),
    writeFile(join(artifactDirectory, `${mode}.pdf`), outputBytes)
  ]);
  await writeFile(join(artifactDirectory, `${mode}.cleanup.json`), `${JSON.stringify({ mode, caseRootRemoved: artifact.cleanup.caseRootRemoved, outputResidueBeforeCleanup: residue }, null, 2)}\n`, "utf8");
  assert.equal(artifact.cleanup.caseRootRemoved, true);
  return artifact;
}

async function mainHarness() {
  assert.equal(existsSync(compiledEntry), true, `compiled CLI entry is missing: ${compiledEntry}`);
  const evidenceRoot = resolve(process.env.YT2SHEET_TASK12_EVIDENCE_DIR ?? join(projectRoot, ".omo/evidence/standards-based-score-review-output/task-12-standards-based-score-review-output"));
  await rm(join(evidenceRoot, "compiled-reviewed-cli"), { recursive: true, force: true });
  await mkdir(evidenceRoot, { recursive: true });
  const rasterBytes = await createA4Pdf("raster-candidate");
  const structuredBytes = await createA4Pdf("structured-candidate");
  const pagePngBytes = [await createReviewPagePng(1), await createReviewPagePng(2)];
  const root = evidenceRoot;
  const structured = await runCase({ mode: "structured", root, rasterBytes, structuredBytes, pagePngBytes });
  const fallback = await runCase({ mode: "fallback", root, rasterBytes, structuredBytes, pagePngBytes });
  const summary = {
    compiledEntry: "dist-cli/cli/index.js",
    unsupportedProbe: "build-cli/cli/index.js was not used; npm run build:cli emits dist-cli/cli/index.js",
    structured,
    fallback,
    rasterCandidateSha256: sha256(rasterBytes),
    structuredCandidateSha256: sha256(structuredBytes),
    structuredDiffersFromRaster: sha256(structuredBytes) !== sha256(rasterBytes),
    cleanup: "case roots removed after each stream capture"
  };
  await writeFile(join(root, "compiled-reviewed-cli", "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ status: "pass", artifact: join(root, "compiled-reviewed-cli", "summary.json") })}\n`);
}

mainHarness().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
