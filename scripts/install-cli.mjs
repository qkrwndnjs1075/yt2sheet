import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

if (process.env.YT2SHEET_SKIP_TOOL_INSTALL === "1") {
  process.exit(0);
}

const compiledBootstrap = resolve(import.meta.dirname, "../dist-cli/cli/yt-dlp-bootstrap.js");

try {
  process.stdout.write("### [1/3] yt-dlp 준비 확인 중...\n");
  await access(compiledBootstrap);
  const { ensureYtDlpExecutable } = await import(pathToFileURL(compiledBootstrap).href);
  await ensureYtDlpExecutable((progress) => writeProgress(progress));
  process.stdout.write("### [3/3] yt-dlp 준비 완료\n");
} catch (error) {
  const message = error instanceof Error ? error.message : "알 수 없는 설치 오류";
  process.stderr.write(`yt2sheet: yt-dlp 자동 준비를 건너뛰었습니다. 첫 실행 때 다시 시도합니다. (${message})\n`);
}

function writeProgress(progress) {
  const labels = {
    checking: "확인 중",
    checksum: "무결성 정보 확인 중",
    download: "다운로드 중",
    verify: "무결성 검증 중",
    ready: "준비 완료"
  };
  const detail = progress.phase === "download" && progress.totalBytes === undefined && progress.downloadedBytes !== undefined
    ? `${Math.max(1, Math.round(progress.downloadedBytes / 1024))} KiB 다운로드됨`
    : `${progress.percent}%`;
  process.stdout.write(`\r### yt-dlp ${labels[progress.phase]} ${detail}`);
  if (progress.phase === "ready") {
    process.stdout.write("\n");
  }
}
