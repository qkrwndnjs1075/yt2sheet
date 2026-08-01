import { resolve } from "node:path";
import { parseYouTubeVideoId } from "../src/shared/youtube";

export type CliRunCommand = {
  readonly kind: "run";
  readonly videoUrl: string;
  readonly videoId: string;
  readonly outputPath: string;
  readonly cookiesPath?: string;
  readonly timeRange?: {
    readonly startTimeSec?: number;
    readonly endTimeSec?: number;
  };
};

export type CliParseResult =
  | { readonly kind: "ok"; readonly command: CliRunCommand }
  | { readonly kind: "help" }
  | { readonly kind: "uninstall" }
  | { readonly kind: "error"; readonly message: string };

const DECIMAL_SECONDS_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

export function parseCliArguments(args: readonly string[], cwd = process.cwd()): CliParseResult {
  if (args.length === 0 || args[0]?.trim() === "help") {
    return { kind: "help" };
  }

  if (args[0]?.trim() === "uninstall") {
    return args.length === 1
      ? { kind: "uninstall" }
      : { kind: "error", message: "uninstall 명령은 추가 인자를 받지 않습니다." };
  }

  let videoUrl: string | undefined;
  let outputPath: string | undefined;
  let cookiesPath: string | undefined;
  let startTimeSec: number | undefined;
  let endTimeSec: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const rawArgument = args[index];
    const argument = rawArgument?.trim();
    if (!argument) {
      return { kind: "error", message: "빈 인자는 사용할 수 없습니다." };
    }

    if (argument === "-h" || argument === "--help") {
      return { kind: "help" };
    }

    const outputOption = readOption(argument, "-o", "--output");
    if (outputOption !== null) {
      const value = outputOption || readNextValue(args, index);
      if (!value) {
        return { kind: "error", message: "--output 뒤에 파일 경로를 입력해 주세요." };
      }
      if (outputOption === "") index += 1;
      else if (argument === "-o" || argument === "--output") index += 1;
      outputPath = resolve(cwd, value);
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
      cookiesPath = resolve(cwd, value);
      continue;
    }

    const timeRangeOption = readTimeRangeOption(rawArgument ?? argument);
    if (timeRangeOption !== null) {
      const existingValue = timeRangeOption.name === "--start" ? startTimeSec : endTimeSec;
      if (existingValue !== undefined) {
        return { kind: "error", message: `${timeRangeOption.name} may only be provided once.` };
      }

      const rawValue = timeRangeOption.attached
        ? timeRangeOption.value
        : readNextTimeRangeValue(args, index);
      if (rawValue === null || rawValue === "") {
        return { kind: "error", message: `${timeRangeOption.name} requires a decimal number.` };
      }
      if (!timeRangeOption.attached) index += 1;

      const parsedValue = parseSeconds(rawValue);
      if (parsedValue === undefined) {
        return { kind: "error", message: `${timeRangeOption.name} requires a decimal number.` };
      }
      if (timeRangeOption.name === "--start") startTimeSec = parsedValue;
      else endTimeSec = parsedValue;
      continue;
    }

    if (argument.startsWith("-")) {
      return { kind: "error", message: `알 수 없는 옵션입니다: ${argument}` };
    }
    if (videoUrl !== undefined) {
      return { kind: "error", message: "YouTube 링크는 하나만 입력해 주세요." };
    }
    videoUrl = argument;
  }

  if (!videoUrl) {
    return { kind: "error", message: "YouTube 링크를 입력해 주세요." };
  }

  const videoId = parseYouTubeVideoId(videoUrl);
  if (!videoId) {
    return { kind: "error", message: "올바른 YouTube 링크가 아닙니다." };
  }

  if (startTimeSec !== undefined && endTimeSec !== undefined && endTimeSec <= startTimeSec) {
    return { kind: "error", message: "--end must be greater than --start." };
  }

  const timeRange = startTimeSec !== undefined && endTimeSec !== undefined
    ? { startTimeSec, endTimeSec }
    : startTimeSec !== undefined
      ? { startTimeSec }
      : endTimeSec !== undefined
        ? { endTimeSec }
        : undefined;

  return {
    kind: "ok",
    command: {
      kind: "run",
      videoUrl,
      videoId,
      outputPath: outputPath ?? resolve(cwd, "yt2sheet", `yt2sheet-${videoId}.pdf`),
      ...(cookiesPath ? { cookiesPath } : {}),
      ...(timeRange ? { timeRange } : {})
    }
  };
}

function parseSeconds(value: string): number | undefined {
  if (!DECIMAL_SECONDS_PATTERN.test(value)) return undefined;
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) ? parsedValue : undefined;
}

function readTimeRangeOption(argument: string): {
  readonly name: "--start" | "--end";
  readonly value: string;
  readonly attached: boolean;
} | null {
  if (argument === "--start") return { name: "--start", value: "", attached: false };
  if (argument === "--end") return { name: "--end", value: "", attached: false };
  if (argument.startsWith("--start=")) {
    return { name: "--start", value: argument.slice("--start=".length), attached: true };
  }
  if (argument.startsWith("--end=")) {
    return { name: "--end", value: argument.slice("--end=".length), attached: true };
  }
  return null;
}

function readNextTimeRangeValue(args: readonly string[], index: number): string | null {
  const value = args[index + 1];
  return value !== undefined && !value.startsWith("-") ? value : null;
}

function readOption(argument: string, ...names: readonly string[]): string | null {
  for (const name of names) {
    if (argument === name) return "";
    if (argument.startsWith(`${name}=`)) return argument.slice(name.length + 1).trim();
  }
  return null;
}

function readNextValue(args: readonly string[], index: number): string | null {
  const value = args[index + 1]?.trim();
  return value && !value.startsWith("-") ? value : null;
}
