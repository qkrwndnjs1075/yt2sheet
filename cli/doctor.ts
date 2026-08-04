import { access, constants } from "node:fs/promises";
import { platform, arch } from "node:process";
import { resolve } from "node:path";
import { selectYtDlpAsset } from "./yt-dlp-bootstrap";
import { inspectDoctorTools, type DoctorTooling } from "./doctor-tools";
import { runLocalMediaSmoke } from "./doctor-local-smoke";
import { probeYtDlpRelease, probeYouTubeSource } from "./doctor-network";
import { type MediaTools } from "../pipeline/media-tools";
import type { DoctorCheck, DoctorResult, DoctorStage } from "./doctor-contract";

export type DoctorOptions = {
  readonly cwd?: string;
  readonly offline?: true;
  readonly videoUrl?: string;
  readonly videoId?: string;
  readonly cookiesPath?: string;
  readonly onStage?: (stage: DoctorStage) => void;
};

export type DoctorDependencies = {
  readonly inspectTools?: (cookiesPath?: string) => Promise<DoctorTooling>;
  readonly checkOutputDirectory?: (cwd: string) => Promise<DoctorCheck>;
  readonly runLocalSmoke?: (tools: MediaTools) => Promise<DoctorCheck>;
  readonly probeRelease?: () => Promise<DoctorCheck>;
  readonly probeSource?: (tools: MediaTools, videoUrl: string, videoId?: string) => Promise<DoctorCheck>;
};

export { type DoctorCheck, type DoctorResult, type DoctorTooling };

export async function runDoctor(options: DoctorOptions = {}, dependencies: DoctorDependencies = {}): Promise<DoctorResult> {
  const cwd = options.cwd ?? process.cwd();
  const inspectTools = dependencies.inspectTools ?? inspectDoctorTools;
  const checkOutputDirectory = dependencies.checkOutputDirectory ?? defaultCheckOutputDirectory;
  const runLocalSmoke = dependencies.runLocalSmoke ?? runLocalMediaSmoke;
  const probeRelease = dependencies.probeRelease ?? probeYtDlpRelease;
  const probeSource = dependencies.probeSource ?? probeYouTubeSource;
  const hasSource = options.videoUrl !== undefined;
  const total = hasSource ? 7 : 6;
  const checks: DoctorCheck[] = [];
  let stageIndex = 0;
  const nextStage = (label: string): void => {
    stageIndex += 1;
    options.onStage?.({ index: stageIndex, total, label });
  };

  nextStage("실행 환경");
  checks.push(checkSystem());

  nextStage("미디어 도구");
  const tooling = await inspectTools(options.cookiesPath);
  checks.push(...tooling.checks);

  nextStage("출력 디렉터리");
  checks.push(await checkOutputDirectory(cwd));

  nextStage("쿠키/설정");
  checks.push(await checkCookies(cwd, options.cookiesPath));

  nextStage("로컬 미디어/PDF 스모크");
  checks.push(tooling.canRunLocalSmoke
    ? await runLocalSmoke(tooling.tools)
    : { key: "smoke", label: "로컬 미디어/PDF 스모크", status: "skip", message: "ffmpeg/ffprobe 실패로 실행하지 않았습니다." });

  nextStage("릴리스 네트워크");
  checks.push(options.offline
    ? { key: "network", label: "릴리스 네트워크", status: "skip", message: "--offline으로 건너뛰었습니다." }
    : await probeRelease());

  if (options.videoUrl !== undefined) {
    nextStage("YouTube 소스");
    checks.push(options.offline
      ? { key: "source", label: `YouTube 소스${options.videoId ? ` ${options.videoId}` : ""}`, status: "skip", message: "--offline으로 건너뛰었습니다." }
      : tooling.canCheckSource
        ? await probeSource(tooling.tools, options.videoUrl, options.videoId)
        : { key: "source", label: `YouTube 소스${options.videoId ? ` ${options.videoId}` : ""}`, status: "skip", message: "yt-dlp 또는 JS 런타임 실패로 실행하지 않았습니다." });
  }

  const hasFailure = checks.some((check) => check.status === "fail");
  const hasWarning = checks.some((check) => check.status === "warn" || check.status === "skip");
  return {
    checks,
    status: hasFailure ? "failed" : hasWarning ? "warning" : "ready",
    exitCode: hasFailure ? 1 : 0
  };
}

export function formatDoctorReport(result: DoctorResult): string {
  const lines = ["yt2 doctor", ""];
  for (const check of result.checks) {
    const detail = check.detail ? `\n  ${check.detail}` : "";
    lines.push(`${formatStatus(check.status)} ${check.label}: ${check.message}${detail}`);
  }
  lines.push("", `결과: ${formatOverallStatus(result.status)}`);
  return `${lines.join("\n")}\n`;
}

function checkSystem(): DoctorCheck {
  try {
    selectYtDlpAsset(platform, arch);
    return {
      key: "system",
      label: "실행 환경",
      status: "pass",
      message: `${platform} ${arch}, Node ${process.version}`
    };
  } catch (error: unknown) {
    return {
      key: "system",
      label: "실행 환경",
      status: "fail",
      message: `${platform} ${arch}는 지원되지 않습니다.`,
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

async function defaultCheckOutputDirectory(cwd: string): Promise<DoctorCheck> {
  const outputDirectory = resolve(cwd, "yt2sheet");
  try {
    await access(outputDirectory, constants.W_OK);
    return { key: "output", label: "출력 디렉터리", status: "pass", message: `${outputDirectory}에 쓸 수 있습니다.` };
  } catch (error: unknown) {
    if (isMissingPath(error)) {
      try {
        await access(cwd, constants.W_OK);
        return {
          key: "output",
          label: "출력 디렉터리",
          status: "pass",
          message: `${outputDirectory}를 만들 수 있습니다.`
        };
      } catch (parentError: unknown) {
        return {
          key: "output",
          label: "출력 디렉터리",
          status: "fail",
          message: `${resolve(cwd)}에 출력 디렉터리를 만들 수 없습니다.`,
          detail: parentError instanceof Error ? parentError.message : String(parentError)
        };
      }
    }
    return {
      key: "output",
      label: "출력 디렉터리",
      status: "fail",
      message: `${outputDirectory}에 쓸 수 없습니다.`,
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function checkCookies(cwd: string, explicitPath?: string): Promise<DoctorCheck> {
  const configuredPath = explicitPath?.trim() || process.env.YT_DLP_COOKIES_PATH?.trim();
  if (!configuredPath) {
    return { key: "cookies", label: "쿠키 설정", status: "warn", message: "선택 사항이며 설정되지 않았습니다." };
  }
  const path = resolve(cwd, configuredPath);
  try {
    await access(path, constants.R_OK);
    return { key: "cookies", label: "쿠키 설정", status: "pass", message: `쿠키 파일을 읽을 수 있습니다 (${path}).` };
  } catch (error: unknown) {
    return {
      key: "cookies",
      label: "쿠키 설정",
      status: "fail",
      message: `쿠키 파일을 읽을 수 없습니다 (${path}).`,
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

function formatStatus(status: DoctorCheck["status"]): string {
  switch (status) {
    case "pass": return "✓";
    case "warn": return "!";
    case "fail": return "✗";
    case "skip": return "-";
  }
}

function formatOverallStatus(status: DoctorResult["status"]): string {
  switch (status) {
    case "ready": return "READY";
    case "warning": return "READY WITH WARNINGS";
    case "failed": return "FAILED";
  }
}
