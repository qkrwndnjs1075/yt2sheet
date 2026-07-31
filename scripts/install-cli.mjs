import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

if (process.env.YT2SHEET_SKIP_TOOL_INSTALL === "1") {
  process.exit(0);
}

const compiledBootstrap = resolve(import.meta.dirname, "../dist-cli/cli/yt-dlp-bootstrap.js");

try {
  await access(compiledBootstrap);
  const { ensureYtDlpExecutable } = await import(pathToFileURL(compiledBootstrap).href);
  await ensureYtDlpExecutable();
} catch (error) {
  const message = error instanceof Error ? error.message : "알 수 없는 설치 오류";
  process.stderr.write(`yt2sheet: yt-dlp 자동 준비를 건너뛰었습니다. 첫 실행 때 다시 시도합니다. (${message})\n`);
}
