import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { z } from "zod";
import { corpusManifestSchema } from "../server/benchmark/corpus-schema";
import { BenchmarkRunError, canonicalJson } from "../server/benchmark/runner";

const FIXTURE_ROOT = resolve("tests/fixtures/score-corpus/v1");
const PLAN_PATH = resolve("benchmarks/plans/score-pipeline-v1.json");
const STABLE_FILES = ["run.json", "rights-audit.json", "cases.jsonl", "summary.json", "failures.jsonl", "evidence.jsonl"] as const;
const splitSchema = z.union([z.literal("smoke"), z.literal("calibration"), z.literal("test")]);
const runRecordSchema = z.object({
  claimTier: z.union([z.literal("mechanics-only"), z.literal("external-gated")]),
  qualityClaimsAllowed: z.boolean(),
}).passthrough();
const summaryRecordSchema = z.object({
  groupCount: z.number().int().nonnegative(),
  splitGroupCounts: z.object({ smoke: z.number().int().nonnegative(), calibration: z.number().int().nonnegative(), test: z.number().int().nonnegative() }).strict(),
  requiredTagTestGroupCounts: z.record(z.string(), z.number().int().nonnegative()),
  eligible: z.boolean(),
}).passthrough();
const caseRecordSchema = z.object({
  assetId: z.string().min(1),
  sourceGroupId: z.string().min(1),
  split: splitSchema,
  classTags: z.array(z.string().min(1)),
}).passthrough();
const failureRecordSchema = z.object({
  code: z.union([z.literal("EXTERNAL_INELIGIBLE"), z.literal("PROMOTION_GATE_FAILED")]),
  message: z.string().min(1),
}).passthrough();
const evidenceRecordSchema = z.object({
  schemaVersion: z.literal("score-benchmark-evidence/1"),
  runDigest: z.string().regex(/^[0-9a-f]{64}$/),
  assetId: z.string().min(1),
  sourceGroupId: z.string().min(1),
  split: splitSchema,
  classTags: z.array(z.string().min(1)),
  variant: z.union([z.literal("control"), z.literal("treatment")]),
  sampling: z.object({
    budget: z.number().int().nonnegative(),
    timestampsMs: z.array(z.number().int().nonnegative()),
    candidateCount: z.number().int().nonnegative(),
  }),
  pipelineExecution: z.literal("not-run"),
}).strict();

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
  const evidenceText = await readFile(join(firstDirectory.path, "evidence.jsonl"), "utf8");
  const summaryText = await readFile(join(firstDirectory.path, "summary.json"), "utf8");
  const runRecord = runRecordSchema.parse(JSON.parse(runText));
  const summaryRecord = summaryRecordSchema.parse(JSON.parse(summaryText));
  const caseRecords = casesText.split(/\r?\n/).filter((line) => line.length > 0)
    .map((line) => caseRecordSchema.parse(JSON.parse(line)));
  const evidenceRecords = evidenceText.split(/\r?\n/).filter((line) => line.length > 0)
    .map((line) => evidenceRecordSchema.parse(JSON.parse(line)));
  const manifest = await readManifest(FIXTURE_ROOT);
  const assetIds = manifest.assets.map((asset) => asset.assetId).sort();
  assert.equal(runRecord.claimTier, "mechanics-only");
  assert.equal(runRecord.qualityClaimsAllowed, false);
  assert.equal(summaryRecord.eligible, false);
  assert.equal(summaryRecord.groupCount, new Set(manifest.assets.map((asset) => asset.sourceGroupId)).size);
  assert.deepEqual(summaryRecord.splitGroupCounts, splitGroupCounts(manifest.assets));
  const plan = z.object({ requiredClassTags: z.array(z.string().min(1)).min(1) }).passthrough()
    .parse(JSON.parse(await readFile(PLAN_PATH, "utf8")));
  const expectedRequiredTagTestGroupCounts = Object.fromEntries(plan.requiredClassTags.map((tag) => [tag,
    new Set(manifest.assets.filter((asset) => asset.split === "test" && asset.classTags.some((classTag) => classTag === tag))
      .map((asset) => asset.sourceGroupId)).size]));
  assert.deepEqual(summaryRecord.requiredTagTestGroupCounts, expectedRequiredTagTestGroupCounts);
  assert.deepEqual(groupTagCounts(caseRecords), groupTagCounts(manifest.assets));
  assert.deepEqual(caseRecords.map(({ assetId, sourceGroupId, split, classTags }) => ({ assetId, sourceGroupId, split, classTags })),
    [...manifest.assets].sort((left, right) => left.assetId.localeCompare(right.assetId))
      .map(({ assetId, sourceGroupId, split, classTags }) => ({ assetId, sourceGroupId, split, classTags })));
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
  assert.equal(evidenceRecords.length, assetIds.length * 2);
  assert.deepEqual(evidenceRecords.map((record) => `${record.assetId}:${record.variant}`), assetIds.flatMap((assetId) =>
    [`${assetId}:control`, `${assetId}:treatment`]));
  for (const record of evidenceRecords) {
    assert.equal(record.runDigest, firstDirectory.digest);
    assert.equal(record.pipelineExecution, "not-run");
    assert.equal(record.sampling.candidateCount, record.sampling.timestampsMs.length);
    assert.ok(record.sampling.timestampsMs.every((timestampMs, index, timestampsMs) => {
      const previousTimestampMs = timestampsMs[index - 1];
      return previousTimestampMs === undefined || previousTimestampMs <= timestampMs;
    }));
  }
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

test("completes metrics but exits 4 for an external-gated manifest whose corpus is underqualified", async (t) => {
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
  const failuresText = await readFile(join(directory.path, "failures.jsonl"), "utf8");
  const runRecord = runRecordSchema.parse(JSON.parse(runText));
  const summaryRecord = summaryRecordSchema.parse(JSON.parse(summaryText));
  const failures = failuresText.split(/\r?\n/).filter((line) => line.length > 0)
    .map((line) => failureRecordSchema.parse(JSON.parse(line)));
  assert.equal(runRecord.claimTier, "external-gated");
  assert.equal(runRecord.qualityClaimsAllowed, false);
  assert.equal(summaryRecord.eligible, false);
  assert.ok(summaryRecord.groupCount < 30);
  assert.ok(summaryRecord.splitGroupCounts.calibration < 10);
  assert.ok(summaryRecord.splitGroupCounts.test < 20);
  assert.ok(Object.values(summaryRecord.requiredTagTestGroupCounts).some((count) => count < 5));
  assert.ok(failures.some((failure) => failure.code === "EXTERNAL_INELIGIBLE" && failure.message === "external-eligibility"));
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

function splitGroupCounts(records: readonly { readonly sourceGroupId: string; readonly split: z.infer<typeof splitSchema> }[]) {
  const groups = new Map(records.map((record) => [record.sourceGroupId, record.split]));
  return {
    smoke: [...groups.values()].filter((split) => split === "smoke").length,
    calibration: [...groups.values()].filter((split) => split === "calibration").length,
    test: [...groups.values()].filter((split) => split === "test").length,
  };
}

function groupTagCounts(records: readonly { readonly sourceGroupId: string; readonly classTags: readonly string[] }[]) {
  const groupsByTag = new Map<string, Set<string>>();
  for (const record of records) {
    for (const classTag of record.classTags) {
      const groups = groupsByTag.get(classTag) ?? new Set<string>();
      groups.add(record.sourceGroupId);
      groupsByTag.set(classTag, groups);
    }
  }
  return Object.fromEntries([...groupsByTag.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([classTag, groups]) => [classTag, groups.size]));
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
