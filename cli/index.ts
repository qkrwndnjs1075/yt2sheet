#!/usr/bin/env node

import { ScorePipelineError } from "../server/score-job-service";
import { parseCliArguments } from "./arguments";
import { describeCliError, runCliJob } from "./job";

const usage = `사용법: yt2 <YouTube 링크> [옵션]

옵션:
  -o, --output <경로>   PDF 저장 경로 (기본값: ./yt2sheet-<videoId>.pdf)
      --cookies <경로>  사용자 소유 Netscape 쿠키 파일
  -h, --help            도움말 표시

예시:
  npx yt2sheet https://www.youtube.com/watch?v=1yCkz9VT3ZA
  yt2 https://youtu.be/1yCkz9VT3ZA --output ./scores/song.pdf
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
      onProgress: (progress) => writeProgress(progress)
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

void main().catch((error: unknown) => {
  process.stderr.write(`실패: ${describeCliError(error)}\n`);
  process.exitCode = 1;
});
