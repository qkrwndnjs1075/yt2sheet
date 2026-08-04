import { runProcess, type MediaTools } from "../pipeline/media-tools";
import { resolvePackagedBinary } from "./media-tools";
import type { DoctorCheck } from "./doctor-contract";

const YT_DLP_DOCTOR_TIMEOUT_MS = 20_000;

export type DoctorTooling = {
  readonly tools: MediaTools;
  readonly checks: readonly DoctorCheck[];
  readonly canRunLocalSmoke: boolean;
  readonly canCheckSource: boolean;
};

type ExecutableCheck = {
  readonly path: string;
  readonly available: boolean;
  readonly check: DoctorCheck;
};

export async function inspectDoctorTools(cookiesPath?: string): Promise<DoctorTooling> {
  const [ytDlp, ffmpeg, ffprobe, jsRuntime] = await Promise.all([
    inspectYtDlp(),
    inspectPackagedBinary("ffmpeg", "FFMPEG_PATH"),
    inspectPackagedBinary("ffprobe", "FFPROBE_PATH"),
    inspectJsRuntime()
  ]);
  const tools: MediaTools = {
    ytDlp: ytDlp.path,
    ffmpeg: ffmpeg.path,
    ffprobe: ffprobe.path,
    ytDlpJsRuntime: jsRuntime.path,
    ...(cookiesPath?.trim() || process.env.YT_DLP_COOKIES_PATH?.trim()
      ? { ytDlpCookiesPath: cookiesPath?.trim() || process.env.YT_DLP_COOKIES_PATH?.trim() }
      : {})
  };
  return {
    tools,
    checks: [ytDlp.check, ffmpeg.check, ffprobe.check, jsRuntime.check],
    canRunLocalSmoke: ffmpeg.available && ffprobe.available,
    canCheckSource: ytDlp.available && jsRuntime.available
  };
}

async function inspectYtDlp(): Promise<ExecutableCheck> {
  const configuredPath = process.env.YT_DLP_PATH?.trim();
  if (configuredPath) {
    return inspectExecutable(
      "yt-dlp",
      configuredPath,
      ["--version"],
      "환경 변수 YT_DLP_PATH",
      "실행할 수 없습니다.",
      YT_DLP_DOCTOR_TIMEOUT_MS
    );
  }
  try {
    const version = summarizeVersion(await runProcess("yt-dlp", ["--version"], { timeoutMs: YT_DLP_DOCTOR_TIMEOUT_MS }));
    return {
      path: "yt-dlp",
      available: true,
      check: { key: "yt-dlp", label: "yt-dlp", status: "pass", message: `PATH에서 실행됨 (${version || "버전 확인됨"})` }
    };
  } catch (error: unknown) {
    return {
      path: "yt-dlp",
      available: false,
      check: {
        key: "yt-dlp",
        label: "yt-dlp",
        status: "warn",
        message: "PATH에서 찾지 못했습니다. 첫 실행 시 검증된 바이너리를 준비합니다.",
        detail: describeError(error)
      }
    };
  }
}

async function inspectPackagedBinary(binary: "ffmpeg" | "ffprobe", environmentName: string): Promise<ExecutableCheck> {
  const configuredPath = process.env[environmentName]?.trim();
  if (configuredPath) {
    return inspectExecutable(binary, configuredPath, ["-version"], `환경 변수 ${environmentName}`, "실행할 수 없습니다.");
  }
  try {
    const packagedPath = await resolvePackagedBinary(binary);
    return inspectExecutable(binary, packagedPath, ["-version"], "패키지 번들", "실행할 수 없습니다.");
  } catch (error: unknown) {
    return {
      path: binary,
      available: false,
      check: {
        key: binary,
        label: binary,
        status: "fail",
        message: "패키지 실행 파일을 불러오지 못했습니다.",
        detail: describeError(error)
      }
    };
  }
}

async function inspectJsRuntime(): Promise<ExecutableCheck> {
  const runtimePath = process.env.YT_DLP_JS_RUNTIME?.trim() || "node";
  return inspectExecutable("js-runtime", runtimePath, ["--version"], `JS 런타임 ${runtimePath}`, "실행할 수 없습니다.");
}

async function inspectExecutable(
  key: string,
  executable: string,
  args: readonly string[],
  source: string,
  failureSuffix: string,
  timeoutMs = 5_000
): Promise<ExecutableCheck> {
  try {
    const output = summarizeVersion(await runProcess(executable, args, { timeoutMs }));
    return {
      path: executable,
      available: true,
      check: {
        key,
        label: key,
        status: "pass",
        message: `${source} (${output || "버전 확인됨"})`
      }
    };
  } catch (error: unknown) {
    return {
      path: executable,
      available: false,
      check: {
        key,
        label: key,
        status: "fail",
        message: `${source}: ${failureSuffix}`,
        detail: describeError(error)
      }
    };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summarizeVersion(output: string): string {
  return output.trim().split(/\r?\n/u)[0] ?? "";
}
