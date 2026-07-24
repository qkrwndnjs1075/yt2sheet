import { BenchmarkRunError, canonicalJson, runScoreBenchmark } from "./runner";

const REQUIRED_FLAGS = ["--manifest", "--plan", "--corpus-root", "--output-root"] as const;
const ALLOWED_FLAGS = new Set<string>([...REQUIRED_FLAGS, "--seed"]);
type CliInput = Readonly<{ manifestPath: string; planPath: string; corpusRoot: string; outputRoot: string; seed?: number }>;

class CliUsageError extends Error {
  readonly name = "CliUsageError";
}

function parseArguments(argumentsList: readonly string[]): CliInput {
  if (argumentsList[0] !== "run") throw new CliUsageError();
  const flags = new Map<string, string>();
  for (let index = 1; index < argumentsList.length; index += 2) {
    const flag = argumentsList[index];
    const value = argumentsList[index + 1];
    if (flag === undefined || value === undefined || !ALLOWED_FLAGS.has(flag) || value.startsWith("--") || flags.has(flag)) {
      throw new CliUsageError();
    }
    flags.set(flag, value);
  }
  if (REQUIRED_FLAGS.some((flag) => !flags.has(flag))) throw new CliUsageError();
  const manifestPath = flags.get("--manifest");
  const planPath = flags.get("--plan");
  const corpusRoot = flags.get("--corpus-root");
  const outputRoot = flags.get("--output-root");
  if (manifestPath === undefined || planPath === undefined || corpusRoot === undefined || outputRoot === undefined) throw new CliUsageError();
  const seedText = flags.get("--seed");
  if (seedText === undefined) return { manifestPath, planPath, corpusRoot, outputRoot };
  if (!/^(?:0|[1-9]\d*)$/.test(seedText)) throw new CliUsageError();
  const seed = Number(seedText);
  if (!Number.isSafeInteger(seed) || seed > 0xffff_ffff) throw new CliUsageError();
  return { manifestPath, planPath, corpusRoot, outputRoot, seed };
}

function writeError(code: string, message: string, exitCode: number): void {
  process.stderr.write(`${canonicalJson({ schemaVersion: "score-benchmark-error/1", code, message })}\n`);
  process.exitCode = exitCode;
}

async function main(): Promise<void> {
  const input = parseArguments(process.argv.slice(2));
  const result = await runScoreBenchmark(input);
  if (result.exitCode === 4) writeError("PROMOTION_FAILED", "External benchmark eligibility or promotion gate failed.", 4);
}

main().catch((error: unknown) => {
  if (error instanceof CliUsageError) {
    writeError("USAGE", "Invalid benchmark CLI arguments.", 64);
    return;
  }
  if (error instanceof BenchmarkRunError) {
    if (error.code === "VALIDATION") writeError("VALIDATION_FAILED", error.message, 2);
    else if (error.code === "OVERWRITE") writeError("OVERWRITE_REFUSED", error.message, 5);
    else writeError("RUNTIME_FAILED", error.message, 3);
    return;
  }
  writeError("RUNTIME_FAILED", "Benchmark execution failed.", 3);
});
