import { toErrorMessage } from "./errors";

type LogLevel = "debug" | "info" | "warn" | "error";

const prefix = "[FrameInputCollector]";

export const logger = {
  debug: (...args: unknown[]) => log("debug", args),
  info: (...args: unknown[]) => log("info", args),
  warn: (...args: unknown[]) => log("warn", args),
  error: (...args: unknown[]) => log("error", args)
};

function log(level: LogLevel, args: unknown[]): void {
  console[level](prefix, ...args.map(formatLogArg));
}

function formatLogArg(arg: unknown): unknown {
  if (arg instanceof Error || isObjectWithMessage(arg)) {
    return toErrorMessage(arg);
  }

  if (isPlainObject(arg)) {
    return stringifyObject(arg);
  }

  return arg;
}

function isObjectWithMessage(value: unknown): value is { message: string } {
  return typeof value === "object" && value !== null && "message" in value && typeof (value as { message?: unknown }).message === "string";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function stringifyObject(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
