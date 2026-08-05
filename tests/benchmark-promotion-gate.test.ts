import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { corpusManifestSchema, scoreLabelsSchema } from "../benchmarks/corpus-schema";
import { evaluatePromotion } from "../benchmarks/metrics";
import { LocalVideoScoreProcessor } from "../pipeline/youtube-score-processor";

const digest = "a".repeat(64);
const reference = { relativePath: "x", sha256: digest };
const GENERATED_CORPUS_ROOT = resolve(process.env.YT2SHEET_GENERATED_CORPUS_ROOT?.trim() || ".omo/evidence/standards-based-score-review-output/task-14-standards-based-score-review-output/corpus");
const GENERATED_MANIFEST = join(GENERATED_CORPUS_ROOT, "manifest.json");
const GENERATED_MEDIA_ROOT = join(GENERATED_CORPUS_ROOT, "media");

test("generated corpus tags match rendered variants and cover every required test condition", async () => {
  const manifest = JSON.parse(await readFile(GENERATED_MANIFEST, "utf8")) as {
    readonly assets: readonly { readonly split: string; readonly classTags: readonly string[]; readonly source: { readonly generation?: { readonly renderer: { readonly command: string } } } }[];
  };
  const counts = new Map<string, Set<number>>();
  for (const [index, asset] of manifest.assets.entries()) {
    const command = asset.source.generation?.renderer.command;
    if (asset.split === "test") {
      assert.ok(command);
      const rendered = command.match(/tags=([^ ]+)/u)?.[1]?.split("+") ?? [];
      assert.deepEqual([...asset.classTags].sort(), rendered.sort());
      for (const tag of asset.classTags) counts.set(tag, new Set([...(counts.get(tag) ?? []), index]));
    }
  }
  for (const tag of ["static", "cursor", "scroll", "hard-turn", "fade", "compression", "no-score"]) {
    assert.ok((counts.get(tag)?.size ?? 0) >= 5, `${tag} lacks five rendered test groups`);
  }
});

test("generated corpus records pinned renderer provenance and oracle facts", () => {
  const manifest = {
    schemaVersion: "score-corpus/1", corpusId: "generated", corpusVersion: "1.0.0", createdAt: "2026-08-04T00:00:00.000Z",
    assets: [{
      assetId: "generated-01", sourceGroupId: "group-01", split: "test", classTags: ["static"],
      source: {
        kind: "generated-local", relativePath: "media/01.mp4", sha256: digest, contentSha256: digest, byteLength: 10, durationMs: 1000,
        eventTrace: reference,
        generation: {
          generator: { name: "verovio", version: "6.1.0", command: "verovio --version 6.1.0", provenance: reference },
          renderer: { name: "verovio-svg", version: "6.1.0", command: "verovio --xml-id-seed 1", independent: true },
          musicXml: reference
        }
      },
      rights: {
        decision: "approved", basis: "public-domain", holder: "yt2sheet", licenseExpression: "CC0-1.0", evidence: reference,
        allowedUses: { benchmark: true, derivatives: true, redistribution: true, commercial: true }
      },
      labels: reference
    }]
  };
  const parsedManifest = corpusManifestSchema.parse(manifest);
  const labels = scoreLabelsSchema.parse({
    schemaVersion: "score-labels/1", assetId: "generated-01", durationMs: 1000,
    states: [{ stateId: "one", startMs: 0, endMs: 1000 }], boundaries: [], probes: [],
    oracle: { expectedDisposition: "raster-fallback", expectedPageCount: 1, expectedPageOrder: [1], expectedStaffCounts: [1], expectedSystemCounts: [1], groundTruthMusicXmlSha256: digest },
    annotators: [{ id: "generator", role: "annotator" }], confidence: 1
  });
  assert.equal(parsedManifest.assets[0]?.source.kind, "generated-local");
  assert.equal(labels.oracle?.groundTruthMusicXmlSha256, digest);
});

test("compression fixtures are lossy on decoded production frames", async () => {
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  for (const assetId of ["generated-26", "generated-27", "generated-28", "generated-29", "generated-30"]) {
    const videoPath = join(GENERATED_MEDIA_ROOT, `${assetId}.mp4`);
    const decoded = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", videoPath, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"], { encoding: "buffer" });
    assert.equal(decoded.status, 0, `${assetId} did not decode`);
    assert.ok(decoded.stdout.byteLength > 0, `${assetId} decoded no frame`);
    const metadata = await sharp(decoded.stdout).metadata();
    assert.equal(metadata.width, 640);
    assert.equal(metadata.height, 906);
    const bytes = (await readFile(videoPath)).byteLength;
    assert.ok(bytes < 5_000, `${assetId} is not observably compressed: ${bytes} bytes`);
  }
});

test("promotion lists every production gate failure", () => {
  const result = evaluatePromotion({
    claimTier: "external-gated", groups: [], calibrationTunedDuringRun: false, everyCaseWithinBudget: false,
    rightsAndHashesValid: false, sourceGroupsIsolated: false, allCasesExecuted: false, oracleMatches: false,
    structuredPrecision: 0.5, fallbackRecall: 0, falseHardBlocks: 1, finalPageValidation: 0,
    bootstrap: {
      stateRecall: { replicateCount: 0, lower95: null, upper95: null },
      boundaryRecall: { replicateCount: 0, lower95: null, upper95: null },
      candidateDelta: { replicateCount: 0, lower95: null, upper95: null }
    }
  });
  assert.equal(result.qualityClaimsAllowed, false);
  assert.deepEqual(result.gateFailures, [
    "rights-hash-integrity", "source-group-isolation", "all-cases-executed", "oracle-exactness",
    "structured-precision", "fallback-recall", "false-hard-blocks", "final-page-validation",
    "state-recall-lower95", "boundary-recall-lower95", "candidate-delta-upper95", "case-budget"
  ]);
});

test("local adapter extracts a real frame and writes a PDF without network access", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "yt2sheet-local-benchmark-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const processor = new LocalVideoScoreProcessor({ dataRoot: root, tools: { ffmpeg: process.env.FFMPEG_PATH || "ffmpeg", ffprobe: process.env.FFPROBE_PATH || "ffprobe" } });
  const context = Object.assign((_progress: number) => undefined, { onProgress: (_progress: number) => undefined, signal: new AbortController().signal });
  const result = await processor.process({
    videoPath: resolve("tests/fixtures/score-corpus/v1/media/synthetic-score.svg"), videoId: "local-fixture", durationMs: 2000
  }, context);
  assert.equal(result.pageCount, 1);
  assert.equal(result.reviewOutcome, "raster-fallback");
});
