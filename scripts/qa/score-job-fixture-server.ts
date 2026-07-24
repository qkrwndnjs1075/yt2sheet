// allow: SIZE_OK - this executable keeps the Todo 11 fixture protocol and its process lifecycle in one auditable file.
import { randomUUID } from "node:crypto";
import { constants, watchFile, unwatchFile } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { PDFDocument } from "pdf-lib";
import { z } from "zod";
import { createScoreJobApp } from "../../server/app";
import {
  ScoreJobService,
  ScorePipelineError,
  type ScoreJobInput,
  type ScoreJobProcessor,
  type ScoreJobProcessorContext,
  type ScoreJobResult
} from "../../server/score-job-service";
import { shutdownScoreJobServer } from "../../server/workspace-cleanup";
import { STANDALONE_SCORE_PDF } from "../../src/shared/score-identity-config";

const CONTROL_SCHEMA_VERSION = "score-job-fixture-control/1" as const;
const RESULT_MODES = ["valid", "arbitrary-name", "out-of-root", "symlink"] as const;
const JOB_STATES = ["hold", "release-success", "release-failure", "release-abort"] as const;
const OWNED_RESULT = /^yt2sheet-result-p[1-9][0-9]*-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pdf$/i;

const jobEntrySchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("hold") }).strict(),
  z.object({ state: z.literal("release-abort") }).strict(),
  z.object({ state: z.literal("release-failure") }).strict(),
  z.object({ state: z.literal("release-success"), pageCount: z.number().int().positive() }).strict()
]);
const controlSchema = z.object({
  schemaVersion: z.literal(CONTROL_SCHEMA_VERSION),
  revision: z.number().int().nonnegative(),
  jobs: z.record(z.string().regex(/^[A-Za-z0-9_-]{11}$/), jobEntrySchema)
}).strict();

type ControlFile = z.infer<typeof controlSchema>;
type JobEntry = z.infer<typeof jobEntrySchema>;
type ResultMode = (typeof RESULT_MODES)[number];
type ParsedCommand =
  | { readonly kind: "serve"; readonly host: string; readonly port: number; readonly controlFile: string; readonly dataRoot: string; readonly ttlMs: number; readonly resultMode: ResultMode }
  | { readonly kind: "control-init"; readonly controlFile: string }
  | { readonly kind: "control-update"; readonly controlFile: string; readonly videoId: string; readonly entry: JobEntry }
  | { readonly kind: "tamper"; readonly dataRoot: string };

class FixtureCliError extends Error {
  readonly name = "FixtureCliError";
}

class FixtureProcessor implements ScoreJobProcessor {
  constructor(
    private readonly controlFile: string,
    private readonly dataRoot: string,
    private readonly resultMode: ResultMode
  ) {}

  async process(input: ScoreJobInput, context: ScoreJobProcessorContext): Promise<ScoreJobResult> {
    let abortObserved = context.signal.aborted;
    const observeAbort = (): void => { abortObserved = true; };
    context.signal.addEventListener("abort", observeAbort, { once: true });
    try {
      let revision = -1;
      while (true) {
        const control = await readControl(this.controlFile);
        if (control.revision < revision) {
          throw new FixtureCliError(`Control revision regressed from ${revision} to ${control.revision}`);
        }
        revision = control.revision;
        const entry = control.jobs[input.videoId] ?? { state: "hold" };
        const outcome = await this.applyEntry(entry, input, abortObserved);
        if (outcome !== null) return outcome;
        await waitForControlChange(this.controlFile);
        abortObserved ||= context.signal.aborted;
      }
    } finally {
      context.signal.removeEventListener("abort", observeAbort);
    }
  }

  private async applyEntry(entry: JobEntry, input: ScoreJobInput, abortObserved: boolean): Promise<ScoreJobResult | null> {
    switch (entry.state) {
      case "hold":
        return null;
      case "release-abort":
        throw new DOMException("Fixture job aborted", "AbortError");
      case "release-failure":
        if (abortObserved) throw new DOMException("Fixture job aborted", "AbortError");
        throw new ScorePipelineError("FIXTURE_PIPELINE_FAILURE", "Fixture pipeline failure");
      case "release-success":
        if (abortObserved) throw new DOMException("Fixture job aborted", "AbortError");
        return this.writeResult(entry.pageCount);
      default:
        return assertNever(entry);
    }
  }

  private async writeResult(pageCount: number): Promise<ScoreJobResult> {
    const bytes = await createPdf(pageCount);
    const resultsRoot = resolve(this.dataRoot, "results");
    const ownedName = `yt2sheet-result-p${process.pid}-${randomUUID()}.pdf`;
    switch (this.resultMode) {
      case "valid": {
        const filePath = resolve(resultsRoot, ownedName);
        await writeFile(filePath, bytes, { flag: "wx" });
        return { filePath, pageCount };
      }
      case "arbitrary-name": {
        const filePath = resolve(resultsRoot, "arbitrary-result.pdf");
        await writeFile(filePath, bytes, { flag: "wx" });
        return { filePath, pageCount };
      }
      case "out-of-root": {
        const filePath = resolve(this.dataRoot, `outside-${randomUUID()}.pdf`);
        await writeFile(filePath, bytes, { flag: "wx" });
        return { filePath, pageCount };
      }
      case "symlink": {
        const sentinelDirectory = externalSentinelDirectoryPath(this.dataRoot);
        await mkdir(sentinelDirectory);
        await writeFile(resolve(sentinelDirectory, "sentinel.pdf"), bytes, { flag: "wx" });
        const filePath = resolve(resultsRoot, ownedName);
        await symlink(sentinelDirectory, filePath, process.platform === "win32" ? "junction" : "dir");
        return { filePath, pageCount };
      }
      default:
        return assertNever(this.resultMode);
    }
  }
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv.slice(2));
  switch (command.kind) {
    case "control-init":
      await initializeControl(command.controlFile);
      process.stdout.write(`control initialized revision=0 path=${resolve(command.controlFile)}\n`);
      return;
    case "control-update": {
      const revision = await updateControl(command.controlFile, command.videoId, command.entry);
      process.stdout.write(`control updated revision=${revision} job=${command.videoId} state=${command.entry.state}\n`);
      return;
    }
    case "tamper": {
      const sentinel = await replaceOwnedResultWithSymlink(command.dataRoot);
      process.stdout.write(`tampered owned result with symlink sentinel=${sentinel}\n`);
      return;
    }
    case "serve":
      await runServer(command);
      return;
    default:
      return assertNever(command);
  }
}

async function runServer(command: Extract<ParsedCommand, { kind: "serve" }>): Promise<void> {
  const dataRoot = await preflightDataRoot(command.dataRoot);
  await readControl(command.controlFile);
  const processor = new FixtureProcessor(command.controlFile, dataRoot, command.resultMode);
  const scheduler = {
    schedule: (task: () => Promise<void>) => {
      const timeout = setTimeout(() => { void task(); }, command.ttlMs);
      return { cancel: () => clearTimeout(timeout) };
    }
  };
  const service = new ScoreJobService(processor, { dataRoot, scheduler });
  const app = createScoreJobApp(service);
  const server = serve({ fetch: app.fetch, hostname: command.host, port: command.port }, (info) => {
    process.stdout.write(`fixture listening host=${info.address} port=${info.port} pid=${process.pid} dataRoot=${dataRoot} resultMode=${command.resultMode} ttlMs=${command.ttlMs}\n`);
  });
  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await shutdownScoreJobServer(service, server);
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => { void stop().then(() => process.exit(0)); });
  }
  await new Promise<void>((resolveDone, rejectDone) => {
    server.once("close", resolveDone);
    server.once("error", rejectDone);
  });
}

async function preflightDataRoot(input: string): Promise<string> {
  const absoluteDataRoot = resolve(input);
  await mkdir(absoluteDataRoot, { recursive: true });
  const realDataRoot = await realpath(absoluteDataRoot);
  if (realDataRoot !== absoluteDataRoot) throw new FixtureCliError(`Unsafe data root: ${absoluteDataRoot}`);
  const resultsRoot = resolve(realDataRoot, "results");
  await mkdir(resultsRoot, { recursive: true });
  const stats = await lstat(resultsRoot);
  const resolvedResultsRoot = await realpath(resultsRoot);
  if (stats.isSymbolicLink() || !stats.isDirectory() || resolvedResultsRoot !== resultsRoot) {
    throw new FixtureCliError(`Unsafe results root: ${resultsRoot}`);
  }
  return realDataRoot;
}

async function createPdf(pageCount: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) {
    pdf.addPage([STANDALONE_SCORE_PDF.pageWidth, STANDALONE_SCORE_PDF.pageHeight]);
  }
  return pdf.save({ useObjectStreams: false });
}

async function initializeControl(controlFile: string): Promise<void> {
  const target = resolve(controlFile);
  await mkdir(dirname(target), { recursive: true });
  const initial = { schemaVersion: CONTROL_SCHEMA_VERSION, revision: 0, jobs: {} } satisfies ControlFile;
  const temporary = temporaryPath(target);
  try {
    await writeFile(temporary, `${JSON.stringify(initial)}\n`, { flag: "wx" });
    const handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    await handle.close();
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function updateControl(controlFile: string, videoId: string, entry: JobEntry): Promise<number> {
  const target = resolve(controlFile);
  const current = await readControl(target);
  const next = {
    schemaVersion: CONTROL_SCHEMA_VERSION,
    revision: current.revision + 1,
    jobs: { ...current.jobs, [videoId]: entry }
  } satisfies ControlFile;
  const temporary = temporaryPath(target);
  await writeFile(temporary, `${JSON.stringify(next)}\n`, { flag: "wx" });
  try {
    const latest = await readControl(target);
    if (latest.revision !== current.revision) {
      throw new FixtureCliError(`Stale control revision: expected ${current.revision}, found ${latest.revision}`);
    }
    await rename(temporary, target);
    return next.revision;
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function readControl(controlFile: string): Promise<ControlFile> {
  const text = await readFile(resolve(controlFile), "utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new FixtureCliError(`Unreadable control JSON: ${resolve(controlFile)}`, { cause: error });
  }
  const parsed = controlSchema.safeParse(value);
  if (!parsed.success) throw new FixtureCliError(`Malformed control file: ${parsed.error.message}`);
  return parsed.data;
}

async function waitForControlChange(controlFile: string): Promise<void> {
  const target = resolve(controlFile);
  await new Promise<void>((resolveChanged) => {
    const changed = (): void => {
      unwatchFile(target, changed);
      resolveChanged();
    };
    watchFile(target, { interval: 10, persistent: false }, changed);
  });
}

async function replaceOwnedResultWithSymlink(dataRootInput: string): Promise<string> {
  const dataRoot = resolve(dataRootInput);
  const resultsRoot = resolve(dataRoot, "results");
  const deadline = Date.now() + 5_000;
  let entries: readonly string[] = [];
  while (entries.length === 0 && Date.now() < deadline) {
    entries = (await readdir(resultsRoot)).filter((name) => OWNED_RESULT.test(name));
    if (entries.length === 0) await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  if (entries.length !== 1) throw new FixtureCliError(`Expected one owned result, found ${entries.length}`);
  const ownedPath = resolve(resultsRoot, entries[0] ?? "");
  const stats = await lstat(ownedPath);
  if (stats.isSymbolicLink() || !stats.isFile()) throw new FixtureCliError(`Owned result is unsafe: ${ownedPath}`);
  const sentinelDirectory = externalSentinelDirectoryPath(dataRoot);
  await mkdir(sentinelDirectory);
  const sentinel = resolve(sentinelDirectory, "sentinel.pdf");
  await writeFile(sentinel, "EXTERNAL_SENTINEL_MUST_REMAIN_UNTOUCHED\n", { flag: "wx" });
  const replacement = `${ownedPath}.replacement-${randomUUID()}`;
  await symlink(sentinelDirectory, replacement, process.platform === "win32" ? "junction" : "dir");
  await rm(ownedPath);
  await rename(replacement, ownedPath);
  return sentinel;
}

function externalSentinelDirectoryPath(dataRoot: string): string {
  return resolve(dirname(resolve(dataRoot)), `${resolve(dataRoot).split(/[\\/]/).pop() ?? "data"}-external-sentinel`);
}

function temporaryPath(target: string): string {
  return resolve(dirname(target), `.${target.split(/[\\/]/).pop() ?? "control"}.${process.pid}.${randomUUID()}.tmp`);
}

function parseCommand(argv: readonly string[]): ParsedCommand {
  const explicitVerb = argv[0];
  const servesByDefault = explicitVerb?.startsWith("--") ?? false;
  const verb = servesByDefault ? "serve" : explicitVerb;
  const options = parseOptions(servesByDefault ? argv : argv.slice(1));
  if (verb === "serve") {
    rejectUnknown(options, ["host", "port", "control-file", "data-root", "ttl-ms", "result-mode"]);
    return {
      kind: "serve",
      host: required(options, "host"),
      port: positiveInteger(required(options, "port"), "port"),
      controlFile: required(options, "control-file"),
      dataRoot: required(options, "data-root"),
      ttlMs: positiveInteger(required(options, "ttl-ms"), "ttl-ms"),
      resultMode: literal(required(options, "result-mode"), RESULT_MODES, "result-mode")
    };
  }
  if (verb === "control") return parseControlCommand(options);
  if (verb === "tamper") {
    rejectUnknown(options, ["data-root", "kind"]);
    if (required(options, "kind") !== "replace-owned-with-symlink") throw new FixtureCliError("Invalid tamper kind");
    return { kind: "tamper", dataRoot: required(options, "data-root") };
  }
  throw new FixtureCliError(`Unknown command: ${verb ?? ""}`);
}

function parseControlCommand(options: ReadonlyMap<string, string | true>): ParsedCommand {
  rejectUnknown(options, ["control-file", "init", "job", "state", "page-count"]);
  const controlFile = required(options, "control-file");
  if (options.get("init") === true) {
    if (options.size !== 2) throw new FixtureCliError("--init cannot be combined with update options");
    return { kind: "control-init", controlFile };
  }
  const videoId = required(options, "job");
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new FixtureCliError("--job must be an 11-character video ID");
  const state = literal(required(options, "state"), JOB_STATES, "state");
  const pageCountValue = options.get("page-count");
  if (state !== "release-success") {
    if (pageCountValue !== undefined) throw new FixtureCliError("--page-count is allowed only for release-success");
    return { kind: "control-update", controlFile, videoId, entry: { state } };
  }
  const pageCount = pageCountValue === undefined ? 1 : positiveInteger(String(pageCountValue), "page-count");
  return { kind: "control-update", controlFile, videoId, entry: { state, pageCount } };
}

function parseOptions(argv: readonly string[]): ReadonlyMap<string, string | true> {
  const options = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith("--")) throw new FixtureCliError(`Expected option, found ${token ?? ""}`);
    const key = token.slice(2);
    if (options.has(key)) throw new FixtureCliError(`Duplicate option --${key}`);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) options.set(key, true);
    else {
      options.set(key, next);
      index += 1;
    }
  }
  return options;
}

function rejectUnknown(options: ReadonlyMap<string, string | true>, allowed: readonly string[]): void {
  for (const key of options.keys()) {
    if (!allowed.includes(key)) throw new FixtureCliError(`Unknown option --${key}`);
  }
}

function required(options: ReadonlyMap<string, string | true>, key: string): string {
  const value = options.get(key);
  if (typeof value !== "string" || value.length === 0) throw new FixtureCliError(`Missing --${key}`);
  return value;
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new FixtureCliError(`--${label} must be a positive integer`);
  return parsed;
}

function literal<const T extends readonly string[]>(value: string, values: T, label: string): T[number] {
  const parsed = values.find((candidate) => candidate === value);
  if (parsed === undefined) throw new FixtureCliError(`Invalid --${label}: ${value}`);
  return parsed;
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected variant: ${String(value)}`);
}

void main().catch((error: unknown) => {
  const failure = error instanceof Error ? error : new TypeError(String(error));
  process.stderr.write(`${failure.name}: ${failure.message}\n`);
  process.exitCode = 1;
});
