import { z } from "zod";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const identifierSchema = z.string().min(1);
const sha256Schema = z.string().regex(SHA256_PATTERN);
const relativeFileSchema = z.string().min(1);
const durationSchema = z.number().int().positive();
const timestampSchema = z.number().int().nonnegative();
const fileReferenceSchema = z
  .object({
    relativePath: relativeFileSchema,
    sha256: sha256Schema,
  })
  .strict();

const eventTraceReferenceSchema = fileReferenceSchema;
const sourceCommon = {
  relativePath: relativeFileSchema,
  sha256: sha256Schema,
  byteLength: z.number().int().nonnegative(),
  durationMs: durationSchema,
  eventTrace: eventTraceReferenceSchema,
} as const;

const syntheticSourceSchema = z
  .object({
    kind: z.literal("synthetic"),
    ...sourceCommon,
  })
  .strict();

const externalSourceSchema = z
  .object({
    kind: z.literal("external-local"),
    ...sourceCommon,
    originUrl: z.url().optional(),
  })
  .strict();

const allowedUsesSchema = z
  .object({
    benchmark: z.literal(true),
    derivatives: z.boolean(),
    redistribution: z.boolean(),
    commercial: z.boolean(),
  })
  .strict();

const approvedRightsSchema = z
  .object({
    decision: z.literal("approved"),
    basis: z.enum(["owned", "written-permission", "public-domain", "license"]),
    holder: z.string().min(1),
    licenseExpression: z.string().min(1),
    evidence: fileReferenceSchema,
    allowedUses: allowedUsesSchema,
    expiresAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

const blockedRightsSchema = z
  .object({
    decision: z.literal("blocked"),
    reason: z.enum(["unknown", "expired", "incompatible", "missing-evidence"]),
  })
  .strict();

const assetSchema = z
  .object({
    assetId: identifierSchema,
    sourceGroupId: identifierSchema,
    split: z.enum(["smoke", "calibration", "test"]),
    classTags: z.array(z.enum(["static", "cursor", "scroll", "hard-turn", "fade", "compression", "no-score"])).min(1),
    source: z.discriminatedUnion("kind", [syntheticSourceSchema, externalSourceSchema]),
    rights: z.discriminatedUnion("decision", [approvedRightsSchema, blockedRightsSchema]),
    labels: fileReferenceSchema,
  })
  .strict();

export const corpusManifestSchema = z
  .object({
    schemaVersion: z.literal("score-corpus/1"),
    corpusId: identifierSchema,
    corpusVersion: z.string().regex(SEMVER_PATTERN),
    createdAt: z.iso.datetime({ offset: true }),
    assets: z.array(assetSchema).min(1),
  })
  .strict();

const stateSchema = z
  .object({
    stateId: identifierSchema,
    startMs: timestampSchema,
    endMs: z.number().int().positive(),
  })
  .strict();

const boundarySchema = z
  .object({
    timestampMs: timestampSchema,
    type: z.enum(["hard-turn", "fade-start", "fade-end", "scroll"]),
  })
  .strict();

const rectangleSchema = z
  .object({
    x: timestampSchema,
    y: timestampSchema,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();

const probeSchema = z
  .object({
    timestampMs: timestampSchema,
    hasScore: z.boolean(),
    source: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict(),
    scoreRects: z.array(rectangleSchema),
    notationMask: fileReferenceSchema.optional(),
    nuisanceMask: fileReferenceSchema.optional(),
  })
  .strict();

export const scoreLabelsSchema = z
  .object({
    schemaVersion: z.literal("score-labels/1"),
    assetId: identifierSchema,
    durationMs: durationSchema,
    states: z.array(stateSchema),
    boundaries: z.array(boundarySchema),
    probes: z.array(probeSchema),
    annotators: z.array(z.object({ id: identifierSchema, role: z.enum(["annotator", "adjudicator"]) }).strict()).min(1),
    confidence: z.number().finite().min(0).max(1),
  })
  .strict();

export const scoreEventsSchema = z
  .object({
    schemaVersion: z.literal("score-events/1"),
    assetId: identifierSchema,
    events: z.array(z.object({ timestampMs: timestampSchema, score: z.number().finite().min(0).max(100) }).strict()),
  })
  .strict();

export type CorpusManifest = z.infer<typeof corpusManifestSchema>;
export type CorpusAsset = CorpusManifest["assets"][number];
export type ScoreLabels = z.infer<typeof scoreLabelsSchema>;
export type ScoreEvents = z.infer<typeof scoreEventsSchema>;
