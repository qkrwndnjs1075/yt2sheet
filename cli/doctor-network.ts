import { type IncomingMessage } from "node:http";
import { get } from "node:https";
import { runProcess, type MediaTools } from "../pipeline/media-tools";
import { YT_DLP_RELEASE_VERSION } from "./yt-dlp-bootstrap";
import type { DoctorCheck } from "./doctor-contract";

export async function probeYtDlpRelease(): Promise<DoctorCheck> {
  const url = `https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_RELEASE_VERSION}/SHA2-256SUMS`;
  try {
    const statusCode = await probeHttpStatus(url);
    if (statusCode >= 200 && statusCode < 400) {
      return { key: "network", label: "릴리스 네트워크", status: "pass", message: `GitHub 릴리스에 연결됨 (HTTP ${statusCode})` };
    }
    return { key: "network", label: "릴리스 네트워크", status: "warn", message: `GitHub 릴리스가 HTTP ${statusCode}를 반환했습니다.` };
  } catch (error: unknown) {
    return {
      key: "network",
      label: "릴리스 네트워크",
      status: "warn",
      message: "GitHub 릴리스에 연결하지 못했습니다.",
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function probeYouTubeSource(tools: MediaTools, videoUrl: string, videoId?: string): Promise<DoctorCheck> {
  const args = [
    "--no-playlist",
    "--skip-download",
    "--print",
    "%(duration)s",
    ...(tools.ytDlpCookiesPath ? ["--cookies", tools.ytDlpCookiesPath] : []),
    videoUrl
  ];
  try {
    const output = await runProcess(tools.ytDlp, args, { timeoutMs: 30_000, maxOutputBytes: 200_000 });
    const duration = parseDuration(output);
    if (duration === undefined) {
      return {
        key: "source",
        label: `YouTube 소스${videoId ? ` ${videoId}` : ""}`,
        status: "warn",
        message: "메타데이터는 응답했지만 영상 길이를 확인하지 못했습니다."
      };
    }
    return {
      key: "source",
      label: `YouTube 소스${videoId ? ` ${videoId}` : ""}`,
      status: "pass",
      message: `다운로드 없이 메타데이터 확인됨 (길이 ${formatDuration(duration)})`
    };
  } catch (error: unknown) {
    return {
      key: "source",
      label: `YouTube 소스${videoId ? ` ${videoId}` : ""}`,
      status: "fail",
      message: "YouTube 메타데이터를 확인하지 못했습니다.",
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

function parseDuration(output: string): number | undefined {
  const value = output.trim().split(/\s+/u).at(-1);
  if (!value || value === "NA") return undefined;
  const duration = Number(value);
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

function formatDuration(seconds: number): string {
  const roundedSeconds = Math.round(seconds);
  const minutes = Math.floor(roundedSeconds / 60);
  const remainingSeconds = roundedSeconds % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function probeHttpStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = get(url, { headers: { "user-agent": "yt2sheet-doctor" } }, (response: IncomingMessage) => {
      const statusCode = response.statusCode ?? 0;
      response.resume();
      resolve(statusCode);
    });
    request.setTimeout(10_000, () => {
      request.destroy(new Error("Network probe timed out."));
    });
    request.once("error", reject);
  });
}
