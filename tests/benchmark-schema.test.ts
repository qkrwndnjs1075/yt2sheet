import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { CorpusLoadError, loadScoreCorpus } from "../benchmarks/corpus-loader";
import { corpusManifestSchema, scoreLabelsSchema, type CorpusManifest, type ScoreLabels } from "../benchmarks/corpus-schema";

const fixtureRoot = resolve("tests/fixtures/score-corpus/v1");
const fixedNow = new Date("2026-07-24T00:00:00.000Z");

test("loads strict synthetic and approved external-local assets without copying source bytes", async (t) => {
  // Given a project-generated synthetic asset and an owned non-redistributable external-local asset.
  const root = await copyCorpus(t);
  const before = await inventory(root);
  // When the local corpus is loaded.
  const loaded = await load(root);
  // Then both assets and verified rights evidence are returned without changing the corpus tree.
  assert.deepEqual(loaded.assets.map((entry) => entry.asset.assetId), ["synthetic-score", "external-owned"]);
  assert.equal(loaded.assets[1]?.asset.rights.decision, "approved");
  assert.equal(loaded.assets[1]?.asset.rights.decision === "approved" && loaded.assets[1].asset.rights.allowedUses.redistribution, false);
  assert.equal(loaded.assets[1]?.verifiedHashes.rightsEvidenceSha256.length, 64);
  assert.deepEqual(await inventory(root), before);
});

test("rejects unknown manifest keys", async (t) => {
  // Given an otherwise valid manifest with an undeclared key.
  const root = await copyCorpus(t);
  const manifestText = await readFile(join(root, "manifest.json"), "utf8");
  await writeFile(join(root, "manifest.json"), manifestText.replace('{"schemaVersion":', '{"unexpected":true,"schemaVersion":'));
  // When the corpus boundary parses the manifest.
  const action = load(root);
  // Then strict schema parsing fails closed.
  await rejectsWith(action, "SCHEMA_INVALID");
});

test("rejects traversal before reading an outside source", async (t) => {
  // Given a source path containing parent traversal.
  const root = await copyCorpus(t);
  const manifest = await readManifest(root);
  await writeManifest(root, replaceAsset(manifest, "synthetic-score", (asset) => ({
    ...asset,
    source: { ...asset.source, relativePath: "../outside.svg" },
  })));
  // When the loader resolves local inputs.
  const action = load(root);
  // Then traversal is rejected as a path error.
  await rejectsWith(action, "PATH_INVALID");
});

test("rejects a source path through a linked directory that escapes the corpus root", async (t) => {
  // Given a manifest source reached through a directory junction to an outside file.
  const root = await copyCorpus(t);
  const outsideRoot = await makeTemp(t, "yt2sheet-corpus-outside-");
  const outside = join(outsideRoot, "outside.svg");
  await writeFile(outside, "outside");
  const linked = join(root, "media", "linked-directory");
  await symlink(outsideRoot, linked, "junction");
  const digest = sha256(await readFile(outside));
  const manifest = await readManifest(root);
  await writeManifest(root, replaceAsset(manifest, "synthetic-score", (asset) => ({
    ...asset,
    source: { ...asset.source, relativePath: "media/linked-directory/outside.svg", sha256: digest, byteLength: 7 },
  })));
  // When the loader resolves the source.
  const action = load(root);
  // Then the symlink is rejected without following it.
  await rejectsWith(action, "PATH_INVALID");
});

test("rejects a symlinked corpus root", async (t) => {
  // Given a directory junction used as the configured corpus root.
  const root = await copyCorpus(t);
  const aliasParent = await makeTemp(t, "yt2sheet-corpus-alias-");
  const alias = join(aliasParent, "root-link");
  await symlink(root, alias, "junction");
  // When the loader receives the linked root and manifest.
  const action = loadScoreCorpus({ corpusRoot: alias, manifestPath: join(alias, "manifest.json"), now: fixedNow });
  // Then root confinement rejects it.
  await rejectsWith(action, "PATH_INVALID");
});

test("rejects blocked, expired, and missing benchmark permission before source use", async (t) => {
  await t.test("blocked rights", async (child) => {
    // Given a syntactically valid blocked decision.
    const root = await copyCorpus(child);
    const manifest = await readManifest(root);
    await writeManifest(root, replaceAsset(manifest, "synthetic-score", (asset) => ({ ...asset, rights: { decision: "blocked", reason: "unknown" } })));
    // When the corpus is loaded.
    const action = load(root);
    // Then rights validation rejects it before any asset hash check.
    await rejectsWith(action, "RIGHTS_INVALID");
  });
  await t.test("expired rights", async (child) => {
    // Given approved rights whose expiry precedes the injected clock.
    const root = await copyCorpus(child);
    const manifest = await readManifest(root);
    await writeManifest(root, replaceAsset(manifest, "synthetic-score", (asset) => ({
      ...asset,
      rights: asset.rights.decision === "approved" ? { ...asset.rights, expiresAt: "2026-07-23T23:59:59.000Z" } : asset.rights,
    })));
    // When the corpus is loaded.
    const action = load(root);
    // Then expiry validation rejects it before local media verification.
    await rejectsWith(action, "RIGHTS_INVALID");
  });
  await t.test("missing benchmark permission", async (child) => {
    // Given an approved-rights object with the required benchmark permission removed.
    const root = await copyCorpus(child);
    const text = await readFile(join(root, "manifest.json"), "utf8");
    await writeFile(join(root, "manifest.json"), text.replaceAll('"benchmark":true,', ""));
    // When the corpus is loaded.
    const action = load(root);
    // Then the strict schema rejects the missing permission.
    await rejectsWith(action, "SCHEMA_INVALID");
  });
});

test("rejects source hash and byte-length mismatches", async (t) => {
  await t.test("hash mismatch", async (child) => {
    // Given a declared source digest that differs from the local bytes.
    const root = await copyCorpus(child);
    const manifest = await readManifest(root);
    await writeManifest(root, replaceAsset(manifest, "synthetic-score", (asset) => ({ ...asset, source: { ...asset.source, sha256: "0".repeat(64) } })));
    // When the loader verifies source integrity.
    const action = load(root);
    // Then it fails with the typed integrity error.
    await rejectsWith(action, "INTEGRITY_INVALID");
  });
  await t.test("byte-length mismatch", async (child) => {
    // Given a declared source length that differs from the local bytes.
    const root = await copyCorpus(child);
    const manifest = await readManifest(root);
    await writeManifest(root, replaceAsset(manifest, "synthetic-score", (asset) => ({ ...asset, source: { ...asset.source, byteLength: asset.source.byteLength + 1 } })));
    // When the loader verifies source integrity.
    const action = load(root);
    // Then it fails with the typed integrity error.
    await rejectsWith(action, "INTEGRITY_INVALID");
  });
});

test("rejects duplicate assets, split leakage, and mixed source groups", async (t) => {
  await t.test("duplicate asset IDs", async (child) => {
    // Given two assets with the same identifier.
    const root = await copyCorpus(child);
    const manifest = await readManifest(root);
    const second = manifest.assets[1];
    assert.ok(second);
    await writeManifest(root, { ...manifest, assets: [...manifest.assets, second] });
    // When manifest semantics are checked.
    const action = load(root);
    // Then the duplicate is rejected.
    await rejectsWith(action, "CORPUS_INVALID");
  });
  await t.test("split leakage", async (child) => {
    // Given one source group assigned to smoke and calibration splits.
    const root = await copyCorpus(child);
    const manifest = await readManifest(root);
    await writeManifest(root, replaceAsset(manifest, "external-owned", (asset) => ({ ...asset, sourceGroupId: "synthetic-group" })));
    // When manifest semantics are checked.
    const action = load(root);
    // Then source-group leakage is rejected.
    await rejectsWith(action, "CORPUS_INVALID");
  });
  await t.test("mixed source group", async (child) => {
    // Given synthetic and external-local assets sharing one smoke source group.
    const root = await copyCorpus(child);
    const manifest = await readManifest(root);
    await writeManifest(root, replaceAsset(manifest, "external-owned", (asset) => ({ ...asset, sourceGroupId: "synthetic-group", split: "smoke" })));
    // When manifest semantics are checked.
    const action = load(root);
    // Then the mixed group is rejected.
    await rejectsWith(action, "CORPUS_INVALID");
  });
});

test("rejects invalid external labels and geometric or temporal bounds", async (t) => {
  await t.test("insufficient external reviewers", async (child) => {
    // Given external labels with fewer than two annotators and one adjudicator.
    const root = await copyCorpus(child);
    await replaceLabels(root, "external-owned", (labels) => ({ ...labels, annotators: [{ id: "only-one", role: "annotator" }] }));
    // When labels are loaded.
    const action = load(root);
    // Then external provenance validation rejects them.
    await rejectsWith(action, "CORPUS_INVALID");
  });
  await t.test("overlapping states", async (child) => {
    // Given label intervals that overlap.
    const root = await copyCorpus(child);
    await replaceLabels(root, "synthetic-score", (labels) => ({
      ...labels,
      states: [{ stateId: "a", startMs: 0, endMs: 1200 }, { stateId: "b", startMs: 1000, endMs: 2000 }],
    }));
    // When labels are loaded.
    const action = load(root);
    // Then half-open ordering validation rejects them.
    await rejectsWith(action, "CORPUS_INVALID");
  });
  await t.test("duplicate state IDs", async (child) => {
    // Given two otherwise valid states with the same identifier.
    const root = await copyCorpus(child);
    await replaceLabels(root, "synthetic-score", (labels) => ({
      ...labels,
      states: [{ stateId: "duplicate", startMs: 0, endMs: 1000 }, { stateId: "duplicate", startMs: 1000, endMs: 2000 }],
    }));
    // When labels are loaded.
    const action = load(root);
    // Then duplicate label identifiers are rejected.
    await rejectsWith(action, "CORPUS_INVALID");
  });
  await t.test("confidence outside unit interval", async (child) => {
    // Given label confidence greater than one.
    const root = await copyCorpus(child);
    const manifest = await readManifest(root);
    const asset = manifest.assets.find((entry) => entry.assetId === "synthetic-score");
    assert.ok(asset);
    const path = join(root, ...asset.labels.relativePath.split("/"));
    const text = await readFile(path, "utf8");
    const bytes = Buffer.from(text.replace('"confidence":1', '"confidence":1.01'));
    await writeFile(path, bytes);
    await writeManifest(root, replaceAsset(manifest, asset.assetId, (entry) => ({ ...entry, labels: { ...entry.labels, sha256: sha256(bytes) } })));
    // When labels are parsed.
    const action = load(root);
    // Then strict confidence validation rejects them.
    await rejectsWith(action, "SCHEMA_INVALID");
  });
  await t.test("out-of-bounds rectangle", async (child) => {
    // Given a score rectangle extending beyond its probe source.
    const root = await copyCorpus(child);
    await replaceLabels(root, "synthetic-score", (labels) => ({
      ...labels,
      probes: [{ timestampMs: 250, hasScore: true, source: { width: 640, height: 360 }, scoreRects: [{ x: 600, y: 90, width: 100, height: 190 }] }],
    }));
    // When labels are loaded.
    const action = load(root);
    // Then rectangle bounds validation rejects them.
    await rejectsWith(action, "CORPUS_INVALID");
  });
  await t.test("out-of-bounds event timestamp", async (child) => {
    // Given an event timestamp equal to the half-open duration bound.
    const root = await copyCorpus(child);
    const eventPath = join(root, "events", "synthetic-score.json");
    const eventBytes = Buffer.from('{"schemaVersion":"score-events/1","assetId":"synthetic-score","events":[{"timestampMs":2000,"score":20}]}');
    await writeFile(eventPath, eventBytes);
    const manifest = await readManifest(root);
    await writeManifest(root, replaceAsset(manifest, "synthetic-score", (asset) => ({
      ...asset,
      source: { ...asset.source, eventTrace: { ...asset.source.eventTrace, sha256: sha256(eventBytes) } },
    })));
    // When event labels are loaded.
    const action = load(root);
    // Then timestamp bounds validation rejects it.
    await rejectsWith(action, "CORPUS_INVALID");
  });
});

test("never fetches an external origin URL", async (t) => {
  // Given a live HTTP canary injected only as external origin metadata.
  let connections = 0;
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.end("must-not-fetch");
  });
  server.on("connection", () => {
    connections += 1;
  });
  await listen(server);
  t.after(async () => {
    await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error === undefined ? resolveClose() : rejectClose(error)));
    console.log(JSON.stringify({ canaryTeardown: "closed" }));
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const canaryUrl = `http://127.0.0.1:${address.port}/must-not-fetch`;
  const root = await copyCorpus(t);
  const manifest = await readManifest(root);
  await writeManifest(root, replaceAsset(manifest, "external-owned", (asset) => ({
    ...asset,
    source: asset.source.kind === "external-local" ? { ...asset.source, originUrl: canaryUrl } : asset.source,
  })));
  // When the corpus loader verifies the external-local asset.
  await load(root);
  // Then no TCP connection or HTTP request reaches the live origin canary.
  assert.equal(connections, 0);
  assert.equal(requests, 0);
  console.log(JSON.stringify({ canaryUrl, connections, requests }));
});

async function copyCorpus(t: TestContext): Promise<string> {
  const root = await makeTemp(t, "yt2sheet-corpus-");
  await cp(fixtureRoot, root, { recursive: true });
  return root;
}

async function makeTemp(t: TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function load(root: string) {
  return loadScoreCorpus({ corpusRoot: root, manifestPath: join(root, "manifest.json"), now: fixedNow });
}

async function readManifest(root: string): Promise<CorpusManifest> {
  const raw: unknown = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  return corpusManifestSchema.parse(raw);
}

async function writeManifest(root: string, manifest: CorpusManifest): Promise<void> {
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
}

function replaceAsset(manifest: CorpusManifest, assetId: string, update: (asset: CorpusManifest["assets"][number]) => CorpusManifest["assets"][number]): CorpusManifest {
  return { ...manifest, assets: manifest.assets.map((asset) => asset.assetId === assetId ? update(asset) : asset) };
}

async function replaceLabels(root: string, assetId: string, update: (labels: ScoreLabels) => ScoreLabels): Promise<void> {
  const manifest = await readManifest(root);
  const asset = manifest.assets.find((entry) => entry.assetId === assetId);
  assert.ok(asset);
  const path = join(root, ...asset.labels.relativePath.split("/"));
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  const bytes = Buffer.from(JSON.stringify(update(scoreLabelsSchema.parse(raw))));
  await writeFile(path, bytes);
  await writeManifest(root, replaceAsset(manifest, assetId, (entry) => ({ ...entry, labels: { ...entry.labels, sha256: sha256(bytes) } })));
}

async function rejectsWith(action: Promise<unknown>, code: CorpusLoadError["code"]): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof CorpusLoadError && error.code === code);
}

async function inventory(root: string): Promise<readonly string[]> {
  return (await readdir(root, { recursive: true })).sort();
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function listen(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
}
