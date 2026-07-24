import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { corpusManifestSchema } from "../server/benchmark/corpus-schema";
import { BenchmarkRunError, canonicalJson } from "../server/benchmark/runner";

const FIXTURE_ROOT = resolve("tests/fixtures/score-corpus/v1");
const PLAN_PATH = resolve("benchmarks/plans/score-pipeline-v1.json");
const STABLE_FILES = ["run.json", "rights-audit.json", "cases.jsonl", "summary.json", "failures.jsonl"] as const;

test("returns the strict usage error when the benchmark CLI receives an unknown option", () => {
  // Given the public package-script CLI surface.
  // When an unknown option crosses that boundary.
  const result = spawnSync(process.execPath, ["--import", "tsx", "server/benchmark/cli.ts", "run", "--unknown"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  // Then the CLI emits exactly one compact typed error and exits with EX_USAGE.
  assert.equal(result.status, 64);
  assert.equal(result.stderr, '{"code":"USAGE","message":"Invalid benchmark CLI arguments.","schemaVersion":"score-benchmark-error/1"}\n');
});

test("canonicalizes recursively without reordering arrays and rejects non-finite numbers", () => {
  // Given an object with unsorted nested keys and an intentionally ordered array.
  const input = { z: [{ z: 1, a: 2 }, 3], a: { d: true, b: null } };
  // When the canonical encoder crosses the JSON boundary.
  const encoded = canonicalJson(input);
  // Then object keys are recursive lexicographic order, array order is preserved, and non-finite values fail closed.
  assert.equal(encoded, '{"a":{"b":null,"d":true},"z":[{"a":2,"z":1},3]}');
  assert.throws(() => canonicalJson({ value: Number.POSITIVE_INFINITY }), BenchmarkRunError);
});

test("writes byte-identical stable mechanics artifacts under two output roots", async (t) => {
  // Given the reviewed mixed fixture and immutable benchmark plan.
  const firstRoot = await makeTemp(t, "yt2sheet-benchmark-a-");
  const secondRoot = await makeTemp(t, "yt2sheet-benchmark-b-");
  // When the CLI runs independently under each output root.
  const first = runCli({ corpusRoot: FIXTURE_ROOT, manifestPath: join(FIXTURE_ROOT, "manifest.json"), outputRoot: firstRoot });
  const second = runCli({ corpusRoot: FIXTURE_ROOT, manifestPath: join(FIXTURE_ROOT, "manifest.json"), outputRoot: secondRoot });
  // Then stable artifacts and digest match while only the volatile record differs.
  assert.equal(first.status, 0);
  assert.equal(second.status, 0);
  assert.equal(first.stderr, "");
  assert.equal(second.stderr, "");
  const firstDirectory = await digestDirectory(firstRoot);
  const secondDirectory = await digestDirectory(secondRoot);
  assert.equal(firstDirectory.digest, secondDirectory.digest);
  for (const name of STABLE_FILES) {
    assert.deepEqual(await readFile(join(firstDirectory.path, name)), await readFile(join(secondDirectory.path, name)));
  }
  assert.notDeepEqual(await readFile(join(firstDirectory.path, "run-volatile.json")), await readFile(join(secondDirectory.path, "run-volatile.json")));
  const runText = await readFile(join(firstDirectory.path, "run.json"), "utf8");
  const casesText = await readFile(join(firstDirectory.path, "cases.jsonl"), "utf8");
  assert.match(runText, /"claimTier":"mechanics-only"/);
  assert.match(runText, /"qualityClaimsAllowed":false/);
  assert.match(runText, /"relativePath":"server\/youtube-score-processor\.ts"/);
  const youtubeSource = await readFile(resolve("server/youtube-score-processor.ts"));
  const youtubeSha256 = createHash("sha256").update(youtubeSource).digest("hex");
  assert.match(runText, new RegExp(`"relativePath":"server/youtube-score-processor\\.ts","sha256":"${youtubeSha256}"`));
  const productionModules = (await readdir(resolve("server"), { recursive: true })).filter((path) =>
    path.endsWith(".ts") && !path.replaceAll("\\", "/").startsWith("benchmark/"));
  for (const path of productionModules) {
    assert.doesNotMatch(await readFile(resolve("server", path), "utf8"), /(?:from|import\s*)\s*["'][^"']*benchmark(?:\/|["'])/);
  }
  assert.doesNotMatch(runText, /[A-Z]:\\/i);
  assert.match(casesText, /"runtimeMs":0/);
  const sourceHashes = [...runText.matchAll(/"assetId":"(?:external-owned|synthetic-score)","sha256":"([0-9a-f]{64})"/g)].map((match) => match[1]);
  assert.equal(new Set(sourceHashes).size, 2);
  const emittedNames = await readdir(firstDirectory.path);
  assert.deepEqual(emittedNames.sort(), [...STABLE_FILES, "run-volatile.json"].sort());
});

test("refuses a same-digest overwrite before changing an artifact", async (t) => {
  // Given one completed digest directory and its byte and timestamp inventory.
  const outputRoot = await makeTemp(t, "yt2sheet-benchmark-overwrite-");
  assert.equal(runCli({ corpusRoot: FIXTURE_ROOT, manifestPath: join(FIXTURE_ROOT, "manifest.json"), outputRoot }).status, 0);
  const directory = await digestDirectory(outputRoot);
  const before = await artifactInventory(directory.path);
  // When the identical run targets the same output root.
  const repeated = runCli({ corpusRoot: FIXTURE_ROOT, manifestPath: join(FIXTURE_ROOT, "manifest.json"), outputRoot });
  // Then exit 5 is emitted and the prior directory remains immutable.
  assert.equal(repeated.status, 5);
  assert.equal(repeated.stderr, '{"code":"OVERWRITE_REFUSED","message":"Benchmark digest directory already exists.","schemaVersion":"score-benchmark-error/1"}\n');
  assert.deepEqual(await artifactInventory(directory.path), before);
});

test("rejects blocked rights with exit 2 and no success artifacts", async (t) => {
  // Given a valid local corpus whose first asset is explicitly blocked.
  const corpusRoot = await copyCorpus(t);
  const manifest = await readManifest(corpusRoot);
  const blocked = { ...manifest, assets: manifest.assets.map((asset, index) => index === 0
    ? { ...asset, rights: { decision: "blocked" as const, reason: "unknown" as const } } : asset) };
  await writeFile(join(corpusRoot, "manifest.json"), JSON.stringify(blocked));
  const outputRoot = await makeTemp(t, "yt2sheet-benchmark-blocked-");
  // When the CLI reaches rights validation.
  const result = runCli({ corpusRoot, manifestPath: join(corpusRoot, "manifest.json"), outputRoot });
  // Then validation exits 2 with one compact error and writes no run directory.
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, '{"code":"VALIDATION_FAILED","message":"Benchmark input validation failed.","schemaVersion":"score-benchmark-error/1"}\n');
  assert.deepEqual(await readdir(outputRoot), []);
});

test("completes metrics but exits 4 for an ineligible external locked-test manifest", async (t) => {
  // Given a temporary manifest that explicitly requests external test evaluation with only one group.
  const corpusRoot = await copyCorpus(t);
  const manifest = await readManifest(corpusRoot);
  const externalTest = { ...manifest, assets: manifest.assets.map((asset) => asset.assetId === "external-owned"
    ? { ...asset, split: "test" as const } : asset) };
  await writeFile(join(corpusRoot, "manifest.json"), JSON.stringify(externalTest));
  const outputRoot = await makeTemp(t, "yt2sheet-benchmark-external-");
  // When the external gate runs.
  const result = runCli({ corpusRoot, manifestPath: join(corpusRoot, "manifest.json"), outputRoot });
  // Then completed stable metrics are retained, but the process emits no success and exits 4.
  assert.equal(result.status, 4);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, '{"code":"PROMOTION_FAILED","message":"External benchmark eligibility or promotion gate failed.","schemaVersion":"score-benchmark-error/1"}\n');
  const directory = await digestDirectory(outputRoot);
  const runText = await readFile(join(directory.path, "run.json"), "utf8");
  const summaryText = await readFile(join(directory.path, "summary.json"), "utf8");
  assert.match(runText, /"claimTier":"external-gated"/);
  assert.match(runText, /"qualityClaimsAllowed":false/);
  assert.match(summaryText, /"eligible":false/);
  assert.notEqual((await stat(join(directory.path, "failures.jsonl"))).size, 0);
});

test("rejects a changed or extended immutable benchmark plan", async (t) => {
  // Given the reviewed plan with one changed constant.
  const planRoot = await makeTemp(t, "yt2sheet-benchmark-plan-");
  const planPath = join(planRoot, "changed.json");
  const original = await readFile(PLAN_PATH, "utf8");
  await writeFile(planPath, original.replace('"maxCandidates":3600', '"maxCandidates":3599'));
  const outputRoot = await makeTemp(t, "yt2sheet-benchmark-plan-output-");
  // When the strict CLI loads the altered plan.
  const result = runCli({ corpusRoot: FIXTURE_ROOT, manifestPath: join(FIXTURE_ROOT, "manifest.json"), outputRoot, planPath });
  // Then immutable-plan validation fails before artifact creation.
  assert.equal(result.status, 2);
  assert.deepEqual(await readdir(outputRoot), []);
});

test("rejects an unknown immutable-plan key", async (t) => {
  // Given the reviewed plan extended with an undeclared key.
  const planRoot = await makeTemp(t, "yt2sheet-benchmark-plan-key-");
  const planPath = join(planRoot, "extended.json");
  const original = await readFile(PLAN_PATH, "utf8");
  await writeFile(planPath, original.replace('{"schemaVersion":', '{"unknown":true,"schemaVersion":'));
  const outputRoot = await makeTemp(t, "yt2sheet-benchmark-plan-key-output-");
  // When the strict CLI loads the extended plan.
  const result = runCli({ corpusRoot: FIXTURE_ROOT, manifestPath: join(FIXTURE_ROOT, "manifest.json"), outputRoot, planPath });
  // Then strict-key validation exits 2 before artifact creation.
  assert.equal(result.status, 2);
  assert.deepEqual(await readdir(outputRoot), []);
});

test("uses an explicit uint32 seed in the stable run contract", async (t) => {
  // Given a valid explicit seed distinct from the immutable plan default.
  const outputRoot = await makeTemp(t, "yt2sheet-benchmark-seed-");
  // When the CLI runs with seed zero.
  const result = runCli({ corpusRoot: FIXTURE_ROOT, manifestPath: join(FIXTURE_ROOT, "manifest.json"), outputRoot, seed: 0 });
  // Then the effective seed is recorded in stable output.
  assert.equal(result.status, 0);
  const directory = await digestDirectory(outputRoot);
  assert.match(await readFile(join(directory.path, "run.json"), "utf8"), /"effectiveSeed":0/);
});

type CliScenario = Readonly<{ corpusRoot: string; manifestPath: string; outputRoot: string; planPath?: string; seed?: number }>;

function runCli(scenario: CliScenario) {
  const seedArguments = scenario.seed === undefined ? [] : ["--seed", String(scenario.seed)];
  return spawnSync(process.execPath, ["--import", "tsx", "server/benchmark/cli.ts", "run", "--manifest", scenario.manifestPath,
    "--plan", scenario.planPath ?? PLAN_PATH, "--corpus-root", scenario.corpusRoot, "--output-root", scenario.outputRoot,
    ...seedArguments], { cwd: process.cwd(), encoding: "utf8" });
}

async function makeTemp(t: TestContext, prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function copyCorpus(t: TestContext): Promise<string> {
  const path = await makeTemp(t, "yt2sheet-benchmark-corpus-");
  await cp(FIXTURE_ROOT, path, { recursive: true });
  return path;
}

async function readManifest(root: string) {
  const raw: unknown = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  return corpusManifestSchema.parse(raw);
}

async function digestDirectory(outputRoot: string): Promise<{ readonly digest: string; readonly path: string }> {
  const names = await readdir(outputRoot);
  assert.equal(names.length, 1);
  const digest = names[0];
  if (digest === undefined) throw new TypeError("Benchmark digest directory is missing.");
  assert.match(digest, /^[0-9a-f]{64}$/);
  return { digest, path: join(outputRoot, digest) };
}

async function artifactInventory(path: string) {
  const names = (await readdir(path)).sort();
  return Promise.all(names.map(async (name) => {
    const file = join(path, name);
    const metadata = await stat(file);
    return { name, mtimeMs: metadata.mtimeMs, bytes: await readFile(file) };
  }));
}
