#!/usr/bin/env node

import { ScorePipelineError } from "../pipeline/job-contract";
import { parseCliArguments } from "./arguments";
import { describeCliError, runCliJob } from "./job";
import { formatCliUninstallOutcome, uninstallStandaloneCli } from "./uninstall";
import { formatYtDlpProgress, type YtDlpBootstrapProgress } from "./yt-dlp-bootstrap";

const usage = `yt2 - Generate a sheet-music PDF from a YouTube video

Usage:
  yt2 <youtube-url> [options]
  yt2 help
  yt2 --help

Commands:
  help                  Show this help message
  uninstall             Remove this standalone installation

Options:
  -o, --output <path>   Write the PDF to <path>
      --cookies <path>  Use a user-owned Netscape cookies file
      --start <seconds> Start time in seconds (optional; omitted means 0)
      --end <seconds>   End time in seconds (optional; omitted means video duration)
  -h, --help            Show this help message

Examples:
  yt2 "<youtube-url>"
  yt2 "<youtube-url>" --output ./scores/song.pdf
  yt2 help

Terminal:
  Always wrap the entire URL in double quotes so ? and & reach yt2 unchanged.

Time range:
  --start and --end are optional decimal seconds defining the half-open interval [start,end).
  An omitted --start means 0; an omitted --end means the video duration.
  The interval requires start < end (end must be greater than start).
  The range must fit the video duration: start < duration and end <= duration.
  Ranges outside the video duration are rejected before media processing starts.

Output:
  Without --output, writes ./yt2sheet/yt2sheet-<videoId>.pdf in the current directory.
  Existing default files are preserved as yt2sheet-<videoId>-2.pdf, -3.pdf, and so on.
  Videos are processed locally on your computer.

Uninstall:
  For an npm installation, run: npm uninstall -g yt2sheet
`;

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseCliArguments(args);
  if (parsed.kind === "help") {
    process.stdout.write(usage);
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

  const controller = new AbortController();
  const onInterrupt = (): void => {
    if (controller.signal.aborted) return;
    process.stderr.write("\n취소 중...\n");
    controller.abort();
  };
  process.once("SIGINT", onInterrupt);

  try {
    process.stdout.write("처리 중... 0%");
    const result = await runCliJob({
      ...parsed.command,
      signal: controller.signal,
      onProgress: (progress) => writeProgress(progress),
      onInstallProgress: (progress) => writeInstallProgress(progress)
    });
    process.stdout.write(`\r처리 중... 100%\n완료: ${result.outputPath} (${result.pageCount}페이지)\n`);
  } catch (error: unknown) {
    const message = error instanceof ScorePipelineError ? error.publicMessage : describeCliError(error);
    process.stdout.write("\n");
    process.stderr.write(`실패: ${message}\n`);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }
}

function writeProgress(progress: number): void {
  const value = Math.max(0, Math.min(100, Math.round(progress)));
  process.stdout.write(`\r처리 중... ${value}%`);
}

function writeInstallProgress(progress: YtDlpBootstrapProgress): void {
  const line = formatYtDlpProgress(progress);
  process.stdout.write(progress.phase === "ready" ? `\r${line}\n` : `\r${line}`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`실패: ${describeCliError(error)}\n`);
  process.exitCode = 1;
});
