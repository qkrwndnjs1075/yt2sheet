#!/usr/bin/env node

import packageMetadata from "../package.json";
import { ScorePipelineError } from "../pipeline/job-contract";
import { scoreReviewContract, type ScoreReviewDecision } from "../pipeline/score-review-contract";
import { formatResolvedScoreTimeRange } from "../pipeline/score-time-range";
import { parseCliArguments } from "./arguments";
import { formatDoctorReport, runDoctor } from "./doctor";
import { describeCliError, runCliJob } from "./job";
import { formatCliUninstallOutcome, uninstallStandaloneCli } from "./uninstall";
import { createCliProgressReporter, createYtDlpProgressReporter } from "./progress";

export type CliMainDependencies = {
  readonly runJob?: typeof runCliJob;
  readonly runDoctor?: typeof runDoctor;
};

const usage = `yt2sheet ${packageMetadata.version} - Generate a reviewed sheet-music PDF from a YouTube video

Usage:
  yt2 <youtube-url> [options]
  yt2 help
  yt2 --help
  yt2 version

Commands:
  help                  Show this help message
  version               Show the installed yt2sheet version
  doctor [youtube-url]  Diagnose the local install and optional YouTube source
  uninstall             Remove this standalone installation

Options:
  -o, --output <path>   Write the PDF to <path>
      --cookies <path>  Use a user-owned Netscape cookies file
      --start <time>    Start time: seconds, MM:SS(.fraction), or H:MM:SS
      --end <time>      End time: seconds, MM:SS(.fraction), or H:MM:SS
  -h, --help            Show this help message
  -v, --version         Show the installed yt2sheet version

Examples:
  yt2 "<youtube-url>"
  yt2 "<youtube-url>" --output ./scores/song.pdf
  yt2 doctor
  yt2 doctor "<youtube-url>" --offline
  yt2 version
  yt2 help

Terminal:
  Always wrap the entire URL in double quotes so ? and & reach yt2 unchanged.

Time range:
  --start and --end accept decimal seconds, MM:SS(.fraction), or H:MM:SS and define [start,end).
  An omitted --start means 0; an omitted --end means the video duration.
  The interval requires start < end (end must be greater than start).
  The range must fit the video duration: start < duration and end <= duration.
  Ranges outside the video duration are rejected before media processing starts.
  The final duration-resolved interval is printed before media download begins.

Output:
  Without --output, writes ./yt2sheet/yt2sheet-<videoId>.pdf in the current directory.
  Existing default files are preserved as yt2sheet-<videoId>-2.pdf, -3.pdf, and so on.
  Success exposes one public PDF and no public sidecar; warnings go to stderr, not a JSON output.
  The physical page is ISO 216 A4: 595.28 × 841.89 points. Its embedded raster is 1200 × 1697 raster pixels at 145.14 DPI.
  Videos are processed locally on your computer after the source media is available.

Review and publication:
  The nine phases: info, download, extraction, raster analysis, raster review, OMR, MusicXML validation, engraving, and PDF publication.
  structured approval publishes a validated engraved result. A structured-tool or validation warning selects a raster fallback only when the reviewed raster is safe.
  A hard block (unsafe/unreadable/clipped raster, invalid final PDF, or publication failure) exits nonzero and publishes no new PDF.

Supported bundled runtimes:
  Standalone targets are Windows Server 2022 x64; macOS 14 x64 or arm64; and Ubuntu 22.04/24.04 x64 only.
  Audiveris 5.11.0 and MuseScore 4.7.4 are bundled and pinned. Bootstrap caps each runtime archive at 750 MiB, installed runtimes at 2 GiB, and temporary extraction at 4 GiB.
  npm installation bootstraps bundled tools over the network; it is not an offline install. After installation, local review and PDF generation support offline processing except for YouTube/source downloads.

Doctor:
  yt2 doctor checks runtime manifest, Audiveris, MuseScore, MusicXML schemas, score fonts, license notices, SBOM, source manifest, and CLI probes,
  plus media tools, output permissions, optional cookies, and a local PNG-to-MXL-to-PDF smoke.
  Add --offline to skip release and source-network probes. Doctor never installs tools or reads browser cookies.

Progress:
  Stages: the nine phases: info, download, extraction, raster analysis, raster review, OMR, MusicXML validation, engraving, and PDF publication.
  Interactive terminals redraw one staged progress line; piped output writes one stable line per stage to stderr.
  Successful processing writes only the final PDF path to stdout.

Uninstall:
  Standalone: yt2 uninstall. npm: npm uninstall -g yt2sheet

Compliance and limitations:
  The npm archive and standalone bundle root contain THIRD_PARTY_NOTICES.md, bom.cdx.json, and SOURCE_MANIFEST.json.
  The standalone runtime bundle additionally contains source archives under THIRD_PARTY/sources/.
  MusicXML is the structured interchange and schema-validation format. SMuFL defines music-font glyph semantics. ISO 216 defines the A4 paper geometry.
  Recognition accuracy is not guaranteed. Engraving quality is not guaranteed. PDF 2.0 conformance is not guaranteed.
`;

export async function main(
  args: readonly string[] = process.argv.slice(2),
  dependencies: CliMainDependencies = {}
): Promise<void> {
  const executeJob = dependencies.runJob ?? runCliJob;
  const executeDoctor = dependencies.runDoctor ?? runDoctor;
  const parsed = parseCliArguments(args);
  if (parsed.kind === "help") {
    process.stdout.write(usage);
    return;
  }
  if (parsed.kind === "version") {
    process.stdout.write(`${packageMetadata.name} ${packageMetadata.version}\n`);
    return;
  }
  if (parsed.kind === "error") {
    process.stderr.write(`오류: ${parsed.message}\n\n${usage}`);
    process.exitCode = 1;
    return;
  }
  if (parsed.kind === "uninstall") {
    try {
      process.stdout.write(formatCliUninstallOutcome(await uninstallStandaloneCli()));
    } catch (error: unknown) {
      process.stderr.write(`실패: ${describeCliError(error)}\n`);
      process.exitCode = 1;
    }
    return;
  }
  if (parsed.kind === "doctor") {
    try {
      const result = await executeDoctor({
        ...parsed.command,
        cwd: process.cwd(),
        onStage: (stage) => process.stderr.write(`[doctor ${stage.index}/${stage.total}] ${stage.label}\n`)
      });
      process.stdout.write(formatDoctorReport(result));
      process.exitCode = result.exitCode;
    } catch (error: unknown) {
      process.stderr.write(`실패: ${describeCliError(error)}\n`);
      process.exitCode = 1;
    }
    return;
  }

  const controller = new AbortController();
  const progressReporter = createCliProgressReporter(process.stderr);
  const installProgressReporter = createYtDlpProgressReporter(process.stderr);
  const onInterrupt = (): void => {
    if (controller.signal.aborted) return;
    process.stderr.write("\n취소 중...\n");
    controller.abort();
  };
  process.once("SIGINT", onInterrupt);

  try {
    progressReporter.onProgress(0);
    const result = await executeJob({
      ...parsed.command,
      signal: controller.signal,
      onProgress: progressReporter.onProgress,
      onTimeRangeResolved: (timeRange) => {
        progressReporter.finish();
        process.stderr.write(`최종 해석 범위: ${formatResolvedScoreTimeRange(timeRange)}\n`);
      },
      onInstallProgress: installProgressReporter.onProgress
    });
    progressReporter.onProgress(100);
    progressReporter.finish();
    installProgressReporter.finish();
    process.stderr.write(formatCliWarnings(result.warnings));
    process.stdout.write(`${result.outputPath}\n`);
  } catch (error: unknown) {
    const message = error instanceof ScorePipelineError ? error.publicMessage : describeCliError(error);
    progressReporter.finish();
    installProgressReporter.finish();
    process.stderr.write(`실패: ${message}\n`);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`실패: ${describeCliError(error)}\n`);
  process.exitCode = 1;
});

export function formatCliWarnings(warnings: readonly ScoreReviewDecision[] | undefined): string {
  if (warnings === undefined || warnings.length === 0) return "";
  return warnings.map((warning) => `경고: ${scoreReviewContract(warning.code).cliMessage}\n`).join("");
}
