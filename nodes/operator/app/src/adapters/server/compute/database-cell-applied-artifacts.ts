// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
/**
 * Module: `@adapters/server/compute/database-cell-applied-artifacts`
 * Purpose: Decode authenticated native receipts using their full measurements.
 * Scope: Pure byte-hash, relation fingerprint and supplementary metadata validation.
 * Invariants: Every relation is compared; receipt hashes differ from dataset fingerprints.
 * Side-effects: none
 * Links: types/database-cell.ts, shared/secrets/database-cell-placement.data.ts
 * @internal
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { DatabaseCellAppliedEvidenceBundleSchema } from "@/shared/secrets/database-cell-placement.data";
import type { DatabaseCellAppliedEvidenceKind } from "@/types/database-cell";

const Digest = z.string().regex(/^[0-9a-f]{64}$/);
const Id = z.string().regex(/^\d+$/);
const Fingerprint = z.object({
  copyHeader: z.string().min(1),
  rows: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256Sum: Digest,
  sha256Xor: Digest,
});
const SourceParity = z.object({ tables: z.array(Fingerprint).min(1) });
const RecoveryParity = z.object({
  allMatch: z.literal(true),
  tables: z
    .array(Fingerprint.extend({ cluster: Id, match: z.literal(true) }))
    .min(1),
});
const SchemaObject = z.object({
  schema: z.string(),
  type: z.string(),
  name: z.string(),
  owner: z.string(),
  definitionSha256: Digest,
});
const SchemaFingerprint = z.object({
  method: z.literal("pg15-normalized-schema-object-definitions-sha256.v1"),
  objectCount: z.number().int().positive(),
  fullSchemaFingerprintSha256: Digest,
  objects: z.array(SchemaObject).min(1),
});
const DatabaseMetadata = z.object({
  systemId: Id,
  currentDatabase: z.string(),
  database: z.object({
    name: z.string(),
    owner: z.string(),
    acl: z.array(z.string()),
    encoding: z.string(),
    collation: z.string(),
    ctype: z.string(),
    connectionLimit: z.number().int(),
    allowConnections: z.boolean(),
    isTemplate: z.boolean(),
  }),
  roleMemberships: z.array(
    z.object({
      role: z.string(),
      member: z.string(),
      grantor: z.string(),
      adminOption: z.boolean(),
    })
  ),
  roles: z.array(
    z.object({
      name: z.string(),
      superuser: z.boolean(),
      inherit: z.boolean(),
      createRole: z.boolean(),
      createDb: z.boolean(),
      replication: z.boolean(),
      bypassRls: z.boolean(),
      login: z.boolean(),
      connectionLimit: z.number().int(),
      config: z.array(z.string()),
    })
  ),
});
type Canonical =
  | null
  | boolean
  | number
  | string
  | readonly Canonical[]
  | { readonly [key: string]: Canonical };
/** Matches native UTF8 canonical JSON: sorted object keys, no whitespace. */
export function canonicalEvidenceJson(value: Canonical): string {
  if (Array.isArray(value))
    return `[${value.map((x) => canonicalEvidenceJson(x)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as { readonly [key: string]: Canonical };
    return `{${Object.keys(object)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalEvidenceJson(object[key] ?? null)}`
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
export const evidenceSha256 = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const same = (a: Canonical, b: Canonical) =>
  canonicalEvidenceJson(a) === canonicalEvidenceJson(b);
/** Only bootstrap's node-owned private bank supplies this bundle. */
export function decodeAppliedEvidenceBundle(value: unknown, nodeId: string) {
  const bundle = DatabaseCellAppliedEvidenceBundleSchema.parse(value);
  if (bundle.nodeId !== nodeId || bundle.environment !== "production")
    throw new Error("applied_evidence_owned_identity_mismatch");
  const artifacts = new Map<
    DatabaseCellAppliedEvidenceKind,
    { sha256: string; json: unknown }
  >();
  for (const artifact of bundle.artifacts) {
    const bytes = Buffer.from(artifact.bytesBase64, "base64");
    if (evidenceSha256(bytes) !== artifact.sha256)
      throw new Error("applied_evidence_byte_hash_mismatch");
    artifacts.set(artifact.kind, {
      sha256: artifact.sha256,
      json: JSON.parse(bytes.toString("utf8")),
    });
  }
  return {
    require(kind: DatabaseCellAppliedEvidenceKind) {
      const artifact = artifacts.get(kind);
      if (!artifact)
        throw new Error("applied_evidence_required_artifact_missing");
      return artifact;
    },
  };
}
export function qualifyAppliedDataParity(input: {
  source: unknown;
  recovery: unknown;
  recoverySystemId: string;
  expectedRelations: readonly string[];
}) {
  const source = SourceParity.parse(input.source),
    recovery = RecoveryParity.parse(input.recovery);
  function rows(values: z.infer<typeof Fingerprint>[]) {
    const result = new Map<string, z.infer<typeof Fingerprint>>();
    for (const value of values) {
      const relation = /^COPY ([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*) \(/.exec(
        value.copyHeader
      )?.[1];
      if (!relation || result.has(relation))
        throw new Error("applied_parity_relation_invalid_or_duplicate");
      result.set(relation, value);
    }
    return result;
  }
  const original = rows(source.tables),
    restored = rows(recovery.tables),
    expected = [...input.expectedRelations].sort(compare);
  if (
    new Set(expected).size !== expected.length ||
    !same([...original.keys()].sort(compare), expected) ||
    !same([...restored.keys()].sort(compare), expected)
  )
    throw new Error("applied_parity_relation_coverage_mismatch");
  if (recovery.tables.some((table) => table.cluster !== input.recoverySystemId))
    throw new Error("applied_parity_recovery_cluster_mismatch");
  const normalized = expected.map((relation) => {
    const before = original.get(relation),
      after = restored.get(relation);
    if (!before || !after || !same(before, Fingerprint.parse(after)))
      throw new Error("applied_parity_native_fingerprint_mismatch");
    return { relation, ...before };
  });
  return {
    relations: expected,
    rowCount: normalized
      .reduce((sum, row) => sum + BigInt(row.rows), 0n)
      .toString(),
    fullDataFingerprintSha256: evidenceSha256(
      canonicalEvidenceJson(normalized)
    ),
  };
}
export function qualifyAppliedSchemaFingerprint(value: unknown) {
  const parsed = SchemaFingerprint.parse(value);
  const objects = [...parsed.objects].sort(
    (a, b) =>
      compare(a.schema, b.schema) ||
      compare(a.type, b.type) ||
      compare(a.name, b.name) ||
      compare(a.owner, b.owner)
  );
  const identities = objects.map(({ schema, type, name, owner }) =>
    canonicalEvidenceJson([schema, type, name, owner])
  );
  if (
    new Set(identities).size !== objects.length ||
    parsed.objectCount !== objects.length ||
    evidenceSha256(canonicalEvidenceJson(objects)) !==
      parsed.fullSchemaFingerprintSha256
  )
    throw new Error("applied_schema_object_fingerprint_mismatch");
  return {
    objects,
    objectCount: parsed.objectCount,
    fullSchemaFingerprintSha256: parsed.fullSchemaFingerprintSha256,
  };
}
/** pg_dump without --create requires an authenticated globals supplement. */
export function qualifyAppliedDatabaseMetadata(input: {
  source: unknown;
  recovery: unknown;
  databaseName: string;
  recoverySystemId: string;
}) {
  const source = DatabaseMetadata.parse(input.source),
    recovery = DatabaseMetadata.parse(input.recovery);
  if (
    source.database.name !== input.databaseName ||
    recovery.database.name !== input.databaseName ||
    recovery.currentDatabase !== input.databaseName ||
    recovery.systemId !== input.recoverySystemId ||
    source.systemId === recovery.systemId
  )
    throw new Error("applied_database_metadata_physical_scope_mismatch");
  const db = (value: typeof source.database) => ({
    ...value,
    acl: [...value.acl].sort(compare),
  });
  if (!same(db(source.database), db(recovery.database)))
    throw new Error("applied_database_owner_acl_locale_mismatch");
  const memberships = (value: typeof source.roleMemberships) =>
    value.map((row) => canonicalEvidenceJson(row)).sort(compare);
  if (
    !same(
      memberships(source.roleMemberships),
      memberships(recovery.roleMemberships)
    )
  )
    throw new Error("applied_database_role_membership_mismatch");
  const recovered = new Map(recovery.roles.map((role) => [role.name, role]));
  if (
    recovered.size !== recovery.roles.length ||
    new Set(source.roles.map((role) => role.name)).size !== source.roles.length
  )
    throw new Error("applied_database_duplicate_role");
  for (const original of source.roles) {
    const actual = recovered.get(original.name);
    const normalize = ({
      login: _login,
      config,
      ...attributes
    }: typeof original) => ({
      ...attributes,
      config: [...config].sort(compare),
    });
    if (
      !actual ||
      actual.login ||
      !same(normalize(original), normalize(actual))
    )
      throw new Error("applied_database_role_bounds_or_fence_mismatch");
  }
  return {
    databaseName: source.database.name,
    sourceSystemIdentifier: source.systemId,
    recoverySystemIdentifier: recovery.systemId,
    recoveryDatabase: recovery.database,
  };
}

/** Full object arrays remain in proof custody; this is the actual native hash comparison receipt. */
export function qualifyAppliedSchemaMatch(input: {
  value: unknown;
  archiveSha256: string;
  recoverySystemId: string;
  backupSystemId: string;
  expectedObjectCount: number;
}) {
  const result = z
    .object({
      event: z.literal(
        "actual_scheduled_backup_recovery_full_schema_fingerprints_compared"
      ),
      observedAt: z.string().datetime({ offset: true }),
      qualifiedAt: z.string().datetime({ offset: true }),
      fullMatch: z.literal(true),
      method: z.literal("pg15-normalized-schema-object-definitions-sha256.v1"),
      backupSystemIdentifier: Id,
      rawArrayArtifacts: z
        .array(
          z.object({
            path: z.string().min(1),
            sha256: Digest,
            bytes: z.number().int().positive(),
          })
        )
        .length(2),
      backupArchiveSha256: Digest,
      backupObjectCount: z.number().int().positive(),
      recoveryObjectCount: z.number().int().positive(),
      backupFullSchemaFingerprintSha256: Digest,
      recoveryFullSchemaFingerprintSha256: Digest,
      recoverySystemIdentifier: Id,
    })
    .parse(input.value);
  if (
    result.backupArchiveSha256 !== input.archiveSha256 ||
    result.backupSystemIdentifier !== input.backupSystemId ||
    result.backupObjectCount !== input.expectedObjectCount ||
    new Set(result.rawArrayArtifacts.map((x) => x.path)).size !== 2 ||
    result.recoverySystemIdentifier !== input.recoverySystemId ||
    result.backupObjectCount !== result.recoveryObjectCount ||
    result.backupFullSchemaFingerprintSha256 !==
      result.recoveryFullSchemaFingerprintSha256
  )
    throw new Error("applied_actual_full_schema_hash_mismatch");
  return {
    fullSchemaFingerprintSha256: result.backupFullSchemaFingerprintSha256,
    objectCount: result.backupObjectCount,
    observedAt: result.observedAt,
  };
}
