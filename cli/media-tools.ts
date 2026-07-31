import { ScorePipelineError } from "../server/score-job-service";
import { runProcess, type MediaTools } from "../server/media-tools";
import { ensureYtDlpExecutable } from "./yt-dlp-bootstrap";

export async function resolveCliMediaTools(cookiesPath?: string): Promise<MediaTools> {
  const [ffmpegPath, ffprobePath] = await Promise.all([
    resolvePackagedBinary("ffmpeg"),
    resolvePackagedBinary("ffprobe")
  ]);
  const configuredYtDlp = process.env.YT_DLP_PATH?.trim();
  const ytDlp = configuredYtDlp || await resolveYtDlpPath();
  const configuredCookiesPath = cookiesPath?.trim() || process.env.YT_DLP_COOKIES_PATH?.trim();

  return {
    ytDlp,
    ffmpeg: process.env.FFMPEG_PATH?.trim() || ffmpegPath,
    ffprobe: process.env.FFPROBE_PATH?.trim() || ffprobePath,
    ytDlpJsRuntime: process.env.YT_DLP_JS_RUNTIME?.trim() || "node",
    ...(configuredCookiesPath ? { ytDlpCookiesPath: configuredCookiesPath } : {})
  };
}

async function resolveYtDlpPath(): Promise<string> {
  try {
    await runProcess("yt-dlp", ["--version"], { timeoutMs: 5_000 });
    return "yt-dlp";
  } catch {
    try {
      return await ensureYtDlpExecutable();
    } catch (error: unknown) {
      if (error instanceof ScorePipelineError) throw error;
      throw new ScorePipelineError(
        "TOOL_MISSING",
        "yt-dlp를 자동으로 준비하지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.",
        { cause: error }
      );
    }
  }
}

async function resolvePackagedBinary(binary: "ffmpeg" | "ffprobe"): Promise<string> {
  try {
    if (binary === "ffmpeg") {
      const installer = await import("ffmpeg-static");
      const binaryPath = installer.default;
      if (!binaryPath) {
        throw new Error("ffmpeg-static did not provide a binary path.");
      }
      return binaryPath;
    }
    const installer = await import("@ffprobe-installer/ffprobe");
    return installer.path;
  } catch (error: unknown) {
    throw new ScorePipelineError(
      "TOOL_MISSING",
      `현재 OS/CPU용 ${binary} 실행 파일을 불러오지 못했습니다.`,
      { cause: error }
    );
  }
}
