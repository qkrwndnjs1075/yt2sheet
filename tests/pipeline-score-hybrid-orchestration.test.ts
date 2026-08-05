import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { zipSync } from "fflate";
import { PDFDocument, type PDFPage } from "pdf-lib";
import { PDFDict, PDFName, PDFNumber, PDFRawStream, PDFStream } from "pdf-lib/cjs/core";
import type { AudiverisPageMxl, AudiverisResult } from "../pipeline/audiveris-adapter";
import type { MuseScoreRenderResult } from "../pipeline/musescore-adapter";
import { RASTER_REVIEW_POLICY_DIGEST, type RasterReviewResult } from "../pipeline/score-raster-review";
import type { ScoreReviewDecisionInput } from "../pipeline/score-review-contract";
import {
  createScorePdfFromFrames,
  orchestrateReviewedScorePipeline,
  type ReviewedScorePipelineStage,
  type ReviewedScorePipelineStages,
  type ReviewedRasterPage
} from "../pipeline/score-video-processor";

const STRUCTURED_WARNINGS = [
  warning("OMR_UNAVAILABLE", { tool: "audiveris", versionProbe: "missing" }),
  warning("OMR_TIMEOUT", { timeoutMs: 30_000 }),
  warning("OMR_FAILED", { exitCode: 7, logSummary: "exit" }),
  warning("MXL_UNSAFE", { reason: "traversal" }),
  warning("MUSICXML_INVALID", { validationReason: "schema" }),
  warning("STRUCTURED_LINEAGE_MISMATCH", { expectedPageNumber: 2, actualPageNumber: 3 }),
  warning("ENGRAVER_UNAVAILABLE", { tool: "musescore", versionProbe: "missing" }),
  warning("ENGRAVER_TIMEOUT", { timeoutMs: 30_000 }),
  warning("ENGRAVER_FAILED", { exitCode: 9, logSummary: "exit" }),
  warning("STRUCTURED_PDF_INVALID", { validationReason: "boundary-ink" })
] as const;

describe("reviewed score pipeline state machine", () => {
  it("runs analysis and deduplication into a two-page reviewed structured result", async (t) => {
    // Given: two production-shaped local score frames that compose as separate A4 raster pages.
    const root = await mkdtemp(join(tmpdir(), "yt2sheet-reviewed-frames-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const first = join(root, "frame-1.png");
    const second = join(root, "frame-2.png");
    const output = join(root, "result.pdf");
    const stageOrder: string[] = [];
    let internalReport: unknown;
    await Promise.all([writeTallScoreFrame(first, 180), writeTallScoreFrame(second, 720)]);
    const stages: ReviewedScorePipelineStages = {
      async reviewRaster({ pages }) {
        stageOrder.push("raster-review");
        return passRasterReview(pages.length);
      },
      async transcribe({ pages }) {
        stageOrder.push("audiveris");
        return structuredMxl(pages.length);
      },
      async render(request) {
        stageOrder.push("musescore");
        await writePdf(request.outputPath, request.pages.length, "structured-local-frame");
        return {
          ok: true,
          outputPath: request.outputPath,
          pages: request.pages.map((page) => ({
            ...page,
            outputPageNumber: page.pageNumber,
            systemCount: page.sourceSystemCount,
            staffGroupCount: page.sourceStaffGroupCount,
            boundaryInk: false,
            pdfSha256: "d".repeat(64)
          }))
        };
      }
    };

    // When: the real frame analysis, deduplication, page rendering, and reviewed orchestration execute.
    const result = await createScorePdfFromFrames([first, second], root, output, {
      metadata: { videoId: "local-two-page", createdAt: new Date("2026-08-04T00:00:00.000Z") },
      reviewedPipeline: { stages, reportSink: async (report) => { internalReport = report; } }
    });

    // Then: both ordered pages are selected from the structured lane through one final artifact.
    assert.equal(result.pageCount, 2);
    assert.equal(result.scoreCount, 2);
    assert.equal(result.reviewOutcome, "structured");
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(stageOrder, ["raster-review", "audiveris", "musescore"]);
    assert.equal((await PDFDocument.load(await readFile(output))).getPageCount(), 2);
    await assert.rejects(readdir(join(root, "omr-pages")));
    const evidenceDirectory = process.env["YT2SHEET_TASK11_EVIDENCE_DIR"];
    if (evidenceDirectory !== undefined) {
      await mkdir(evidenceDirectory, { recursive: true });
      await Promise.all([
        copyFile(output, join(evidenceDirectory, "qa-happy-final.pdf")),
        copyFile(join(root, "reviewed-raster.pdf"), join(evidenceDirectory, "qa-happy-raster.pdf")),
        copyFile(join(root, "reviewed-structured.pdf"), join(evidenceDirectory, "qa-happy-structured.pdf")),
        writeFile(join(evidenceDirectory, "qa-happy.json"), JSON.stringify({ result, stageOrder, internalReport }, null, 2))
      ]);
    }
  });

  it("keeps reviewed raster pages low resolution while transcribing temporary A4 300-DPI pages", async (t) => {
    // Given: a production-shaped score frame and a reviewed pipeline that records both raster and OMR page inputs.
    const root = await mkdtemp(join(tmpdir(), "yt2sheet-reviewed-omr-resolution-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const frame = join(root, "frame.png");
    const output = join(root, "result.pdf");
    const reviewedRaster = join(root, "reviewed-raster.pdf");
    const omrPageDirectory = join(root, "omr-pages");
    const reviewDimensions: Array<{ readonly width: number; readonly height: number }> = [];
    const transcriptionDimensions: Array<{ readonly width: number; readonly height: number }> = [];
    const transcriptionPaths: string[] = [];
    const transcriptionLineage: ReviewedRasterPage["lineage"][] = [];
    const sharp = (await import("sharp")).default;
    await Promise.all([
      writeTallScoreFrame(frame, 180),
      mkdir(omrPageDirectory, { recursive: true }).then(() => writeFile(join(omrPageDirectory, "stale.png"), "stale"))
    ]);

    const stages: ReviewedScorePipelineStages = {
      async reviewRaster({ pages }) {
        for (const page of pages) {
          const metadata = await sharp(page.path).metadata();
          reviewDimensions.push({ width: metadata.width ?? 0, height: metadata.height ?? 0 });
        }
        return passRasterReview(pages.length);
      },
      async transcribe({ pages }) {
        for (const page of pages) {
          const metadata = await sharp(page.path).metadata();
          transcriptionDimensions.push({ width: metadata.width ?? 0, height: metadata.height ?? 0 });
          transcriptionPaths.push(page.path);
          transcriptionLineage.push(page.lineage);
        }
        return { kind: "raster-fallback", warning: warning("OMR_FAILED", { exitCode: 1, logSummary: "fixture" }) };
      },
      async render() { throw new TypeError("unreachable engraving"); }
    };

    // When: the real frame analysis, packing, raster PDF composition, and reviewed pipeline execute.
    const result = await createScorePdfFromFrames([frame], root, output, {
      metadata: { videoId: "omr-resolution", createdAt: new Date("2026-08-05T00:00:00.000Z") },
      reviewedPipeline: { stages }
    });

    // Then: review/publication retain the established raster contract, while only transcription receives 300-DPI A4 pages.
    assert.equal(result.reviewOutcome, "raster-fallback");
    assert.deepEqual(reviewDimensions, [{ width: 1200, height: 1697 }]);
    assert.deepEqual(transcriptionDimensions, [{ width: 2480, height: 3508 }]);
    assert.deepEqual(transcriptionLineage, [{ pageNumber: 1, sourceFrameIds: ["frame-000001"], sourceScoreIds: ["score-0001"] }]);
    assert.deepEqual(transcriptionPaths, [join(omrPageDirectory, "page-0001.png")]);
    for (const path of transcriptionPaths) await assert.rejects(readFile(path));
    await assert.rejects(readFile(join(omrPageDirectory, "stale.png")));
    assert.deepEqual(embeddedPageImage((await PDFDocument.load(await readFile(reviewedRaster))).getPage(0)), { width: 1200, height: 1697 });
    assert.deepEqual(embeddedPageImage((await PDFDocument.load(await readFile(output))).getPage(0)), { width: 1200, height: 1697 });
  });

  it("removes temporary OMR pages when transcription fails or is repeatedly cancelled", async (t) => {
    // Given: failure and repeated cancellation exits after high-resolution pages have been rendered.
    const variants = [
      { name: "failure", cancel: false },
      { name: "cancellation-1", cancel: true },
      { name: "cancellation-2", cancel: true }
    ] as const;
    for (const variant of variants) await t.test(variant.name, async (inner) => {
      const root = await mkdtemp(join(tmpdir(), `yt2sheet-reviewed-omr-${variant.name}-`));
      inner.after(() => rm(root, { recursive: true, force: true }));
      const frame = join(root, "frame.png");
      const output = join(root, "result.pdf");
      const controller = new AbortController();
      await writeTallScoreFrame(frame, 180);
      const stages: ReviewedScorePipelineStages = {
        async reviewRaster({ pages }) { return passRasterReview(pages.length); },
        async transcribe() { throw new TypeError("fixture transcription failure"); },
        async render() { throw new TypeError("unreachable engraving"); }
      };

      // When: the reviewed pipeline exits exceptionally at the transcription boundary.
      const result = createScorePdfFromFrames([frame], root, output, {
        signal: controller.signal,
        metadata: { videoId: variant.name, createdAt: new Date("2026-08-05T00:00:00.000Z") },
        reviewedPipeline: {
          stages,
          onStage(stage) { if (variant.cancel && stage === "audiveris") controller.abort(); }
        }
      });

      // Then: the original failure propagates and the high-resolution directory is absent after each interruption.
      await assert.rejects(result, variant.cancel ? { name: "AbortError" } : { name: "TypeError" });
      await assert.rejects(readdir(join(root, "omr-pages")));
      await assert.rejects(readFile(output));
    });
  });

  it("selects one complete structured document with ordered lineage and no intermediate publication", async (t) => {
    // Given: two reviewed raster pages and successful per-page OMR and engraving stages.
    const fixture = await createFixture(t);
    const stages = successfulStages(fixture);

    // When: the complete reviewed pipeline is orchestrated.
    const result = await orchestrateReviewedScorePipeline(fixture.request(stages));

    // Then: only the final structured candidate is committed and ordered lineage is reported internally.
    assert.deepEqual(result, { filePath: fixture.output, pageCount: 2, reviewOutcome: "structured", warnings: [] });
    assert.equal(await sha256(fixture.output), await sha256(fixture.structured));
    assert.deepEqual(fixture.calls, ["raster-review", "audiveris", "mxl-validation", "musescore", "selection", "final-validation", "commit"]);
    assert.deepEqual(fixture.reports, [{
      selectedLane: "structured",
      pageLineage: fixture.pages.map((page) => page.lineage),
      warnings: [],
      review: {
        disposition: "structured",
        selectedLane: "structured",
        exitCode: 0,
        decisions: [{ pageNumber: null, code: "STRUCTURED_SELECTED", evidence: { pageCount: 2 } }]
      }
    }]);
    assert.deepEqual(await readdir(fixture.publicDirectory), ["result.pdf"]);
    assert.deepEqual((await readdir(fixture.workspace)).filter((name) => name.endsWith(".mxl")), []);
  });

  it("falls back to the complete raster when a successful renderer reports the raster path", async (t) => {
    // Given: a renderer writes a valid structured candidate but reports the reviewed raster as its output.
    const fixture = await createFixture(t);
    const stages = {
      ...successfulStages(fixture),
      render: async (request: { readonly pages: readonly { readonly pageNumber: number; readonly sourceSystemCount: number; readonly sourceStaffGroupCount: number }[]; readonly outputPath: string }) => {
        fixture.calls.push("musescore");
        await writePdf(request.outputPath, request.pages.length, "structured-rendered");
        return {
          ok: true as const,
          outputPath: fixture.raster,
          pages: request.pages.map((page) => ({
            ...page,
            mxlPath: join(fixture.workspace, `review-page-${String(page.pageNumber).padStart(4, "0")}.mxl`),
            outputPageNumber: page.pageNumber,
            systemCount: page.sourceSystemCount,
            staffGroupCount: page.sourceStaffGroupCount,
            boundaryInk: false,
            pdfSha256: "a".repeat(64)
          }))
        } satisfies MuseScoreRenderResult;
      }
    };

    // When: orchestration receives the misleading success result.
    const result = await orchestrateReviewedScorePipeline(fixture.request(stages));

    // Then: the published bytes are the complete raster and structured selection is impossible.
    assert.equal(result.reviewOutcome, "raster-fallback");
    assert.equal(await sha256(fixture.output), fixture.rasterSha256);
    assert.notEqual(await sha256(fixture.output), await sha256(fixture.structured));
    assert.deepEqual(fixture.calls, ["raster-review", "audiveris", "mxl-validation", "musescore", "selection", "final-validation", "commit"]);
    const evidenceDirectory = process.env["YT2SHEET_TASK11_EVIDENCE_DIR"];
    if (evidenceDirectory !== undefined) {
      await mkdir(evidenceDirectory, { recursive: true });
      await Promise.all([
        copyFile(fixture.output, join(evidenceDirectory, "qa-stale-renderer-final.pdf")),
        copyFile(fixture.raster, join(evidenceDirectory, "qa-stale-renderer-raster.pdf")),
        copyFile(fixture.structured, join(evidenceDirectory, "qa-stale-renderer-structured.pdf")),
        writeFile(join(evidenceDirectory, "qa-stale-renderer.json"), JSON.stringify({ result, calls: fixture.calls, finalSha256: await sha256(fixture.output), rasterSha256: fixture.rasterSha256, structuredSha256: await sha256(fixture.structured) }, null, 2))
      ]);
    }
  });

  it("blocks malformed raster review output before every structured tool and publication", async (t) => {
    // Given: an adapter reports an impossible pass with a hard finding, no pages, and an invalid digest.
    const fixture = await createFixture(t);
    const stages = {
      ...successfulStages(fixture),
      reviewRaster: async () => {
        fixture.calls.push("raster-review");
        return {
          status: "pass" as const,
          omrEligible: true,
          findings: [{ pageNumber: 1, code: "RASTER_CROP_CLIPPED" as const, severity: "hard" as const, evidence: { boundaryInkRatio: 0.003, staffGapCrossing: 1 } }],
          pages: [],
          configDigest: "invalid digest"
        } satisfies RasterReviewResult;
      }
    };

    // When/Then: malformed review output blocks before OMR, engraving, selection, or final-artifact creation.
    await assert.rejects(orchestrateReviewedScorePipeline(fixture.request(stages)), { code: "RASTER_REVIEW_FAILED" });
    assert.deepEqual(fixture.calls, ["raster-review"]);
    await assert.rejects(readFile(fixture.output));
    assert.deepEqual(await readdir(fixture.publicDirectory), []);
    const evidenceDirectory = process.env["YT2SHEET_TASK11_EVIDENCE_DIR"];
    if (evidenceDirectory !== undefined) {
      await mkdir(evidenceDirectory, { recursive: true });
      await writeFile(join(evidenceDirectory, "qa-malformed-raster-review.json"), JSON.stringify({ calls: fixture.calls, publicArtifacts: await readdir(fixture.publicDirectory), outputExists: false }, null, 2));
    }
  });

  it("rejects each malformed raster review boundary variant before structured work", async (t) => {
    const reordered = passRasterReview(2);
    const variants: readonly { readonly name: string; readonly review: RasterReviewResult }[] = [
      {
        name: "hard finding with otherwise valid pass",
        review: {
          ...passRasterReview(2),
          findings: [{ pageNumber: 1, code: "RASTER_CROP_CLIPPED", severity: "hard", evidence: { boundaryInkRatio: 0.003, staffGapCrossing: 1 } }]
        }
      },
      { name: "empty observations", review: { ...passRasterReview(2), pages: [] } },
      { name: "reordered observations", review: { ...reordered, pages: [...reordered.pages].reverse() } },
      { name: "invalid digest", review: { ...passRasterReview(2), configDigest: "not-a-sha256" } }
    ];
    for (const variant of variants) await t.test(variant.name, async (inner) => {
      const fixture = await createFixture(inner);
      const stages = {
        ...successfulStages(fixture),
        reviewRaster: async () => {
          fixture.calls.push("raster-review");
          return variant.review;
        }
      };

      await assert.rejects(orchestrateReviewedScorePipeline(fixture.request(stages)), { code: "RASTER_REVIEW_FAILED" });
      assert.deepEqual(fixture.calls, ["raster-review"]);
      await assert.rejects(readFile(fixture.output));
      assert.deepEqual(await readdir(fixture.publicDirectory), []);
    });
  });

  it("rejects a stale valid digest or missing reviewed raster candidate before structured work", async (t) => {
    // Given: a review result that is shape-valid but either stale-authorized or detached from its raster candidate.
    const variants = [
      { name: "stale valid digest", removeRaster: false, configDigest: "b".repeat(64) },
      { name: "missing reviewed raster candidate", removeRaster: true, configDigest: RASTER_REVIEW_POLICY_DIGEST }
    ] as const;
    for (const variant of variants) await t.test(variant.name, async (inner) => {
      const fixture = await createFixture(inner);
      if (variant.removeRaster) await rm(fixture.raster);
      const stages = {
        ...successfulStages(fixture),
        reviewRaster: async () => {
          fixture.calls.push("raster-review");
          return { ...passRasterReview(fixture.pages.length), configDigest: variant.configDigest };
        }
      };

      // When/Then: the hard raster boundary rejects before Audiveris, MuseScore, selection, or publication.
      await assert.rejects(orchestrateReviewedScorePipeline(fixture.request(stages)), { code: "RASTER_REVIEW_FAILED" });
      assert.deepEqual(fixture.calls, ["raster-review"]);
      await assert.rejects(readFile(fixture.output));
      assert.deepEqual(await readdir(fixture.publicDirectory), []);
    });
  });

  it("rejects forged page/frame/score lineage before structured work", async (t) => {
    // Given: a valid raster review result paired with a detached or non-monotonic page lineage.
    const variants = [
      {
        name: "duplicate frame and score ids",
        mutate: (pages: readonly ReviewedRasterPage[]) => pages.map((page, index) => index === 0 ? page : {
          ...page,
          lineage: { ...page.lineage, sourceFrameIds: pages[0]?.lineage.sourceFrameIds ?? [], sourceScoreIds: pages[0]?.lineage.sourceScoreIds ?? [] }
        })
      },
      {
        name: "missing score lineage",
        mutate: (pages: readonly ReviewedRasterPage[]) => pages.map((page, index) => index === 1 ? { ...page, lineage: { ...page.lineage, sourceScoreIds: [] } } : page)
      },
      {
        name: "out-of-order frame lineage",
        mutate: (pages: readonly ReviewedRasterPage[]) => pages.map((page, index) => index === 1 ? { ...page, lineage: { ...page.lineage, sourceFrameIds: ["frame-000000"] } } : page)
      }
    ] as const;
    for (const variant of variants) await t.test(variant.name, async (inner) => {
      const fixture = await createFixture(inner);
      const stages = successfulStages(fixture);
      const pages = variant.mutate(fixture.pages);

      // When/Then: the reviewed boundary rejects lineage before Audiveris, MuseScore, or publication.
      await assert.rejects(orchestrateReviewedScorePipeline({ ...fixture.request(stages), pages }), { code: "RASTER_REVIEW_FAILED" });
      assert.deepEqual(fixture.calls, ["raster-review"]);
      await assert.rejects(readFile(fixture.output));
      assert.deepEqual(await readdir(fixture.publicDirectory), []);
    });
  });

  it("does not accept a pre-existing structured candidate that the renderer did not produce", async (t) => {
    const fixture = await createFixture(t);
    const stages = {
      ...successfulStages(fixture),
      render: async (request: { readonly pages: readonly { readonly pageNumber: number; readonly sourceSystemCount: number; readonly sourceStaffGroupCount: number }[]; readonly outputPath: string }) => {
        fixture.calls.push("musescore");
        return {
          ok: true as const,
          outputPath: request.outputPath,
          pages: request.pages.map((page) => ({
            ...page,
            mxlPath: join(fixture.workspace, `review-page-${String(page.pageNumber).padStart(4, "0")}.mxl`),
            outputPageNumber: page.pageNumber,
            systemCount: page.sourceSystemCount,
            staffGroupCount: page.sourceStaffGroupCount,
            boundaryInk: false,
            pdfSha256: "a".repeat(64)
          }))
        } satisfies MuseScoreRenderResult;
      }
    };

    const result = await orchestrateReviewedScorePipeline(fixture.request(stages));

    assert.equal(result.reviewOutcome, "raster-fallback");
    assert.equal(await sha256(fixture.output), fixture.rasterSha256);
    await assert.rejects(readFile(fixture.structured));
  });

  it("maps every structured warning to the complete byte-identical raster document", async (t) => {
    // Given: each canonical structured warning at either OMR or engraving.
    for (const structuredWarning of STRUCTURED_WARNINGS) {
      await t.test(structuredWarning.code, async (inner) => {
        const fixture = await createFixture(inner);
        let stages = successfulStages(fixture);
        const omrWarning = structuredWarning.code.startsWith("OMR_") || structuredWarning.code === "MXL_UNSAFE" || structuredWarning.code === "MUSICXML_INVALID";
        if (omrWarning) stages = { ...stages, transcribe: async () => ({ kind: "raster-fallback", warning: structuredWarning }) };
        else stages = { ...stages, render: async () => ({ ok: false, failures: [structuredWarning] }) };

        // When: one page/tool/validation warning prevents all-page structured approval.
        const result = await orchestrateReviewedScorePipeline(fixture.request(stages));

        // Then: exit-success outcome selects the untouched complete raster and exposes only the canonical warning.
        assert.equal(result.reviewOutcome, "raster-fallback");
        assert.deepEqual(result.warnings, [structuredWarning]);
        assert.equal(await sha256(fixture.output), fixture.rasterSha256);
        assert.equal(fixture.calls.includes("commit"), true);
        assert.deepEqual(await readdir(fixture.publicDirectory), ["result.pdf"]);
      });
    }
  });

  it("keeps all three raster pages when page two structured validation fails", async (t) => {
    // Given: a three-page raster artifact and invalid page-two MXL.
    const fixture = await createFixture(t, 3);
    const stages = {
      ...successfulStages(fixture),
      transcribe: async () => {
        fixture.calls.push("audiveris");
        const transcription = structuredMxl(3);
        if (transcription.kind !== "structured") return transcription;
        return {
          kind: "structured" as const,
          pages: transcription.pages.map((page) => page.pageNumber === 2 ? { ...page, mxl: Buffer.from("invalid-mxl") } : page)
        };
      }
    };

    // When: structured conversion fails after page one succeeded.
    const result = await orchestrateReviewedScorePipeline(fixture.request(stages));

    // Then: no pages are mixed; the selected artifact is byte-identical to all three reviewed raster pages.
    assert.equal(result.pageCount, 3);
    assert.equal(result.reviewOutcome, "raster-fallback");
    assert.equal(await sha256(fixture.output), fixture.rasterSha256);
    assert.equal((await PDFDocument.load(await readFile(fixture.output))).getPageCount(), 3);
    assert.equal(fixture.calls.includes("musescore"), false);
    const evidenceDirectory = process.env["YT2SHEET_TASK11_EVIDENCE_DIR"];
    if (evidenceDirectory !== undefined) {
      await Promise.all([
        copyFile(fixture.output, join(evidenceDirectory, "qa-invalid-page2-final.pdf")),
        copyFile(fixture.raster, join(evidenceDirectory, "qa-invalid-page2-raster.pdf")),
        writeFile(join(evidenceDirectory, "qa-invalid-page2.json"), JSON.stringify({ result, calls: fixture.calls, rasterSha256: fixture.rasterSha256, finalSha256: await sha256(fixture.output) }, null, 2))
      ]);
    }
  });

  it("blocks a clipped raster before every structured tool and publishes nothing", async (t) => {
    // Given: raster review reports a hard clipping gate.
    const fixture = await createFixture(t);
    const stages = {
      ...successfulStages(fixture),
      reviewRaster: async () => {
        fixture.calls.push("raster-review");
        return {
          ...passRasterReview(fixture.pages.length),
          status: "blocked" as const,
          omrEligible: false,
          findings: [{ pageNumber: 1, code: "RASTER_CROP_CLIPPED" as const, severity: "hard" as const, evidence: { boundaryInkRatio: 0.003, staffGapCrossing: 1 } }]
        };
      }
    };

    // When/Then: the hard gate rejects with no Audiveris, MuseScore, selection, validation, or final artifact.
    await assert.rejects(orchestrateReviewedScorePipeline(fixture.request(stages)), { code: "RASTER_REVIEW_FAILED" });
    assert.deepEqual(fixture.calls, ["raster-review"]);
    await assert.rejects(readFile(fixture.output));
    assert.deepEqual(await readdir(fixture.publicDirectory), []);
    const evidenceDirectory = process.env["YT2SHEET_TASK11_EVIDENCE_DIR"];
    if (evidenceDirectory !== undefined) {
      await writeFile(join(evidenceDirectory, "qa-raster-hard.json"), JSON.stringify({ calls: fixture.calls, publicArtifacts: await readdir(fixture.publicDirectory), outputExists: false }, null, 2));
    }
  });

  it("skips structured tools for a raster warning and selects the reviewed raster", async (t) => {
    // Given: the raster is safe but carries a conservative low-contrast warning.
    const fixture = await createFixture(t);
    const stages = {
      ...successfulStages(fixture),
      reviewRaster: async () => {
        fixture.calls.push("raster-review");
        return {
          ...passRasterReview(fixture.pages.length),
          status: "warning" as const,
          findings: [{ pageNumber: 1, code: "RASTER_LOW_CONTRAST" as const, severity: "warning" as const, evidence: { inkContrast: 20 } }]
        };
      }
    };

    // When: whole-document selection observes the warning.
    const result = await orchestrateReviewedScorePipeline(fixture.request(stages));

    // Then: no structured tool runs and one safe raster artifact is committed successfully.
    assert.equal(result.reviewOutcome, "raster-fallback");
    assert.deepEqual(result.warnings, [{ pageNumber: 1, code: "RASTER_LOW_CONTRAST", evidence: { inkContrast: 20 } }]);
    assert.deepEqual(fixture.calls, ["raster-review", "selection", "final-validation", "commit"]);
    assert.equal(await sha256(fixture.output), fixture.rasterSha256);
  });

  it("honors cancellation at every review boundary and cleans intermediate MXL", async (t) => {
    // Given: each cancellable boundary in the reviewed state machine.
    const boundaries: readonly ReviewedScorePipelineStage[] = [
      "raster-review", "raster-gate", "audiveris", "mxl-validation", "musescore", "selection", "final-validation", "commit"
    ];
    for (const boundary of boundaries) await t.test(boundary, async (inner) => {
      const fixture = await createFixture(inner);
      const controller = new AbortController();
      const stages = successfulStages(fixture);

      // When: cancellation arrives exactly as that stage becomes current.
      const result = orchestrateReviewedScorePipeline(fixture.request(stages, controller.signal, (stage) => {
        if (stage === boundary) controller.abort();
      }));

      // Then: AbortError propagates, no selected artifact exists, and transient MXL is removed.
      await assert.rejects(result, { name: "AbortError" });
      await assert.rejects(readFile(fixture.output));
      assert.deepEqual((await readdir(fixture.workspace)).filter((name) => name.endsWith(".mxl")), []);
    });
  });

  it("honors cancellation during analysis, deduplication, and raster composition", async (t) => {
    // Given: a valid local frame and each pre-review pipeline boundary.
    const boundaries: readonly ReviewedScorePipelineStage[] = ["analysis", "deduplication", "raster-composition"];
    for (const boundary of boundaries) await t.test(boundary, async (inner) => {
      const root = await mkdtemp(join(tmpdir(), "yt2sheet-reviewed-creation-cancel-"));
      inner.after(() => rm(root, { recursive: true, force: true }));
      const frame = join(root, "frame.png");
      const output = join(root, "result.pdf");
      const controller = new AbortController();
      await writeTallScoreFrame(frame, 180);

      // When: cancellation arrives at the named creation boundary.
      const result = createScorePdfFromFrames([frame], root, output, {
        signal: controller.signal,
        metadata: { videoId: "creation-cancel", createdAt: new Date("2026-08-04T00:00:00.000Z") },
        reviewedPipeline: {
          stages: unreachableStages(),
          onStage(stage) { if (stage === boundary) controller.abort(); }
        }
      });

      // Then: AbortError propagates before any selected artifact is created.
      await assert.rejects(result, { name: "AbortError" });
      await assert.rejects(readFile(output));
    });
  });
});

class Fixture {
  readonly publicDirectory: string;
  readonly workspace: string;
  readonly raster: string;
  readonly structured: string;
  readonly output: string;
  readonly pages: readonly { readonly path: string; readonly lineage: { readonly pageNumber: number; readonly sourceFrameIds: readonly string[]; readonly sourceScoreIds: readonly string[] }; readonly sourceSystemCount: number; readonly sourceStaffGroupCount: number }[];
  readonly calls: string[] = [];
  readonly reports: unknown[] = [];
  rasterSha256 = "";

  constructor(root: string, pageCount: number) {
    this.publicDirectory = join(root, "public");
    this.workspace = join(root, "workspace");
    this.raster = join(this.workspace, "raster-reviewed.pdf");
    this.structured = join(this.workspace, "structured.pdf");
    this.output = join(this.publicDirectory, "result.pdf");
    this.pages = Array.from({ length: pageCount }, (_, index) => ({
      path: join(this.workspace, `page-${String(index + 1).padStart(4, "0")}.png`),
      lineage: {
        pageNumber: index + 1,
        sourceFrameIds: [`frame-${String(index + 1).padStart(6, "0")}`],
        sourceScoreIds: [`score-${String(index + 1).padStart(4, "0")}`]
      },
      sourceSystemCount: 4,
      sourceStaffGroupCount: 8
    }));
  }

  request(stages: ReviewedScorePipelineStages, signal = new AbortController().signal, onStage?: (stage: ReviewedScorePipelineStage) => void) {
    return {
      rasterPdfPath: this.raster,
      structuredPdfPath: this.structured,
      outputPath: this.output,
      workspace: this.workspace,
      pages: this.pages,
      signal,
      stages,
      onStage,
      reportSink: async (report: unknown) => { this.reports.push(report); }
    };
  }
}

async function createFixture(t: TestContext, pageCount = 2): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "yt2sheet-reviewed-orchestration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = new Fixture(root, pageCount);
  await Promise.all([mkdir(fixture.publicDirectory, { recursive: true }), mkdir(fixture.workspace, { recursive: true })]);
  await Promise.all([
    writePdf(fixture.raster, pageCount, "raster"),
    writePdf(fixture.structured, pageCount, "structured"),
    ...fixture.pages.map((page) => writeFile(page.path, `page-${page.lineage.pageNumber}`))
  ]);
  fixture.rasterSha256 = await sha256(fixture.raster);
  return fixture;
}

function successfulStages(fixture: Fixture): ReviewedScorePipelineStages {
  return {
    async reviewRaster() {
      fixture.calls.push("raster-review");
      return passRasterReview(fixture.pages.length);
    },
    async transcribe() {
      fixture.calls.push("audiveris");
      return structuredMxl(fixture.pages.length);
    },
    async render(request) {
      fixture.calls.push("musescore");
      await writePdf(request.outputPath, request.pages.length, "structured-rendered");
      return {
        ok: true,
        outputPath: request.outputPath,
        pages: request.pages.map((page) => ({
          ...page,
          outputPageNumber: page.pageNumber,
          systemCount: page.sourceSystemCount,
          staffGroupCount: page.sourceStaffGroupCount,
          boundaryInk: false,
          pdfSha256: "a".repeat(64)
        }))
      } satisfies MuseScoreRenderResult;
    },
    onMxlValidated() { fixture.calls.push("mxl-validation"); },
    onSelection() { fixture.calls.push("selection"); },
    onFinalValidation() { fixture.calls.push("final-validation"); },
    onCommit() { fixture.calls.push("commit"); }
  };
}

function passRasterReview(pageCount: number): RasterReviewResult {
  return {
    status: "pass",
    omrEligible: true,
    findings: [],
    pages: Array.from({ length: pageCount }, (_, index) => ({ pageNumber: index + 1, edgeBandPx: 4, boundaryInkRatio: 0, contamination: "clean" as const })),
    configDigest: RASTER_REVIEW_POLICY_DIGEST
  };
}

function unreachableStages(): ReviewedScorePipelineStages {
  return {
    async reviewRaster() { throw new TypeError("unreachable raster review"); },
    async transcribe() { throw new TypeError("unreachable transcription"); },
    async render() { throw new TypeError("unreachable engraving"); }
  };
}

function structuredMxl(pageCount: number): AudiverisResult {
  return {
    kind: "structured",
    pages: Array.from({ length: pageCount }, (_, index): AudiverisPageMxl => ({
      pageNumber: index + 1,
      lineage: {
        pageNumber: index + 1,
        sourceFrameIds: [`frame-${String(index + 1).padStart(6, "0")}`],
        sourceScoreIds: [`score-${String(index + 1).padStart(4, "0")}`]
      },
      inputSha256: "b".repeat(64),
      outputSha256: "c".repeat(64),
      version: "5.11.0",
      durationMs: 1,
      exitCode: 0,
      logSummary: "ok",
      mxl: validMxl(index + 1)
    }))
  };
}

function validMxl(pageNumber: number): Uint8Array {
  const score = Buffer.from(`<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="${pageNumber}"><attributes><divisions>1</divisions><staves>1</staves></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><staff>1</staff></note></measure></part></score-partwise>`);
  return zipSync({
    "META-INF/container.xml": Buffer.from('<?xml version="1.0"?><container><rootfiles><rootfile full-path="score.musicxml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>'),
    "score.musicxml": score
  }, { level: 6, mtime: new Date("1980-01-01T00:00:00.000Z") });
}

function warning<C extends ScoreReviewDecisionInput["code"]>(code: C, evidence: ScoreReviewDecisionInput["evidence"]): ScoreReviewDecisionInput {
  return { pageNumber: 2, code, evidence };
}

async function writePdf(path: string, pageCount: number, marker: string): Promise<void> {
  const document = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) {
    const page = document.addPage([595.2755905511812, 841.8897637795276]);
    page.drawText(`${marker}-${index + 1}`);
  }
  await writeFile(path, await document.save({ useObjectStreams: false }));
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function embeddedPageImage(page: PDFPage): { readonly width: number; readonly height: number } {
  const resources = page.node.Resources();
  assert.ok(resources, "PDF page resources are required");
  const xObjects = resources.lookupMaybe(PDFName.of("XObject"), PDFDict);
  assert.ok(xObjects, "PDF page must contain an image XObject");
  const images = xObjects.keys().flatMap((name) => {
    const image = xObjects.lookupMaybe(name, PDFStream);
    return image instanceof PDFRawStream ? [image] : [];
  });
  assert.equal(images.length, 1);
  const image = images[0];
  assert.ok(image, "PDF page image is required");
  const width = image.dict.lookupMaybe(PDFName.of("Width"), PDFNumber);
  const height = image.dict.lookupMaybe(PDFName.of("Height"), PDFNumber);
  assert.ok(width, "PDF image width is required");
  assert.ok(height, "PDF image height is required");
  return { width: width.asNumber(), height: height.asNumber() };
}

async function writeTallScoreFrame(path: string, markerX: number): Promise<void> {
  const staffLines = Array.from({ length: 30 }, (_, index) => {
    const y = 80 + index * 28;
    return `<line x1="40" y1="${y}" x2="920" y2="${y}" stroke="black" stroke-width="2"/>`;
  }).join("");
  const image = Buffer.from(`<svg width="960" height="1000" xmlns="http://www.w3.org/2000/svg"><rect width="960" height="1000" fill="white"/>${staffLines}<ellipse cx="${markerX}" cy="300" rx="22" ry="14" fill="black"/><line x1="${markerX + 20}" y1="300" x2="${markerX + 20}" y2="250" stroke="black" stroke-width="5"/></svg>`);
  const sharp = (await import("sharp")).default;
  await sharp(image).png().toFile(path);
}
