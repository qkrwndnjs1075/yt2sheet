import { resolve } from "node:path";
import { parseYouTubeVideoId } from "./youtube";
import type { CliDoctorCommand, CliParseResult } from "./arguments";

export function parseDoctorArguments(args: readonly string[], cwd: string): CliParseResult {
  let videoUrl: string | undefined;
  let cookiesPath: string | undefined;
  let offline = false;

  for (let index = 0; index < args.length; index += 1) {
    const rawArgument = args[index];
    const argument = rawArgument?.trim();
    if (!argument) {
      return { kind: "error", message: "빈 인자는 사용할 수 없습니다." };
    }
    if (argument === "-h" || argument === "--help") {
      return { kind: "help" };
    }
    if (argument === "--offline") {
      if (offline) {
        return { kind: "error", message: "--offline may only be provided once." };
      }
      offline = true;
      continue;
    }

    const cookiesOption = readOption(argument, "--cookies");
    if (cookiesOption !== null) {
      const value = cookiesOption || readNextValue(args, index);
      if (!value) {
        return { kind: "error", message: "--cookies 뒤에 쿠키 파일 경로를 입력해 주세요." };
      }
      if (cookiesOption === "") index += 1;
      else if (argument === "--cookies") index += 1;
      if (cookiesPath !== undefined) {
        return { kind: "error", message: "--cookies may only be provided once." };
      }
      cookiesPath = resolve(cwd, value);
      continue;
    }

    if (argument === "--start" || argument === "--end" || argument.startsWith("--start=") || argument.startsWith("--end=")) {
      return { kind: "error", message: "doctor 명령에서는 --start/--end를 사용할 수 없습니다." };
    }
    if (argument.startsWith("-")) {
      return { kind: "error", message: `알 수 없는 doctor 옵션입니다: ${argument}` };
    }
    if (videoUrl !== undefined) {
      return { kind: "error", message: "doctor에는 YouTube 링크를 하나만 입력해 주세요." };
    }
    videoUrl = argument;
  }

  let videoId: string | undefined;
  if (videoUrl !== undefined) {
    const parsedVideoId = parseYouTubeVideoId(videoUrl);
    if (!parsedVideoId) {
      return {
        kind: "error",
        message: "올바른 YouTube 링크가 아닙니다. 터미널에서는 링크 전체를 큰따옴표로 감싸 주세요."
      };
    }
    videoId = parsedVideoId;
  }

  const command: CliDoctorCommand = {
    kind: "doctor",
    ...(videoUrl ? { videoUrl, videoId } : {}),
    ...(cookiesPath ? { cookiesPath } : {}),
    ...(offline ? { offline: true } : {})
  };
  return { kind: "doctor", command };
}

function readOption(argument: string, name: "--cookies"): string | null {
  if (argument === name) return "";
  if (argument.startsWith(`${name}=`)) return argument.slice(name.length + 1).trim();
  return null;
}

function readNextValue(args: readonly string[], index: number): string | null {
  const value = args[index + 1]?.trim();
  return value && !value.startsWith("-") ? value : null;
}
