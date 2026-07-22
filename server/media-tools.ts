import { spawn } from "node:child_process";
import { ScorePipelineError } from "./score-job-service";

export type MediaTools = {
  readonly ytDlp: string;
  readonly ffmpeg: string;
  readonly ffprobe: string;
};

export const defaultMediaTools: MediaTools = {
  ytDlp: process.env.YT_DLP_PATH?.trim() || "yt-dlp",
  ffmpeg: process.env.FFMPEG_PATH?.trim() || "ffmpeg",
  ffprobe: process.env.FFPROBE_PATH?.trim() || "ffprobe"
};

type RunOptions = {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
};

export async function assertMediaTools(tools: MediaTools): Promise<void> {
  await Promise.all([
    runProcess(tools.ytDlp, ["--version"], { timeoutMs: 15_000 }),
    runProcess(tools.ffmpeg, ["-version"], { timeoutMs: 15_000 }),
    runProcess(tools.ffprobe, ["-version"], { timeoutMs: 15_000 })
  ]).catch((error: unknown) => {
    throw new ScorePipelineError(
      "TOOL_MISSING",
      "yt-dlp 또는 ffmpeg를 실행할 수 없습니다. 새 터미널을 연 뒤 다시 시도해 주세요.",
      { cause: error }
    );
  });
}

export function runProcess(executable: string, args: readonly string[], options: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const limit = options.maxOutputBytes ?? 2_000_000;
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`Process timed out: ${executable}`));
    }, options.timeoutMs ?? 30 * 60_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = appendBounded(stdout, chunk, limit);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk, limit);
    });
    child.once("error", finish);
    child.once("close", (code) => {
      if (code === 0) {
        finish(null, stdout);
        return;
      }
      const detail = stderr.trim() || stdout.trim() || `exit code ${String(code)}`;
      finish(new Error(`${executable} failed: ${detail}`));
    });

    function finish(error: Error | null, output = ""): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve(output);
      }
    }
  });
}

function appendBounded(current: string, chunk: string, limit: number): string {
  const combined = current + chunk;
  return combined.length <= limit ? combined : combined.slice(combined.length - limit);
}
