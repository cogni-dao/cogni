// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/migrations/migration-receipt`
 * Purpose: The wire contract for a migration RECEIPT — what a node's own migrator says it applied.
 * Scope: Pure parse + diff over one receipt line; does not do IO, not a database client, and never
 *   names a node's DSN.
 * Invariants:
 *   - THE_MIGRATOR_IS_THE_ONLY_AUTHOR: the receipt is emitted by `scripts/db/migrate.mjs`, which runs
 *     inside the node's own workload holding the node's OWN DSN. Nothing else may synthesize one, and
 *     the operator never reads a node database to derive it (docs/spec/multi-node-tenancy.md).
 *   - DECLARED_AND_APPLIED_TRAVEL_TOGETHER: a receipt carries the journal's declared tags AND the
 *     drizzle ledger's applied rows, so "declared but never arrived" is answerable from the receipt
 *     alone — the operator needs neither the node's git tree nor its database to run that gate.
 *   - TWINS: `MIGRATION_RECEIPT_MARKER` + the field names are restated literally in
 *     `scripts/db/migrate.mjs` (a standalone image-copied script that may not import this). The spec
 *     pins both sides so a change to either is a deliberate, reviewed diff.
 * Side-effects: none
 * Links: scripts/db/migrate.mjs, docs/spec/databases.md § 2 Migration Strategy,
 *   docs/spec/multi-node-tenancy.md (NO_CROSS_NODE_QUERIES)
 * @public
 */

/**
 * Line prefix the migrator prints on stdout after a successful migrate. Chosen to be grep-able
 * and version-pinned: a v2 receipt gets a NEW marker rather than a changed payload, so an old
 * migrator image and a new operator never half-understand each other.
 */
export const MIGRATION_RECEIPT_MARKER = "COGNI_MIGRATION_RECEIPT_V1";

import type { AppliedMigration } from "@/types/migration-receipt";

export type { AppliedMigration };

/** What one successful migrate run reports about the database it just migrated. */
export interface MigrationReceipt {
  /** The migrator's `NODE_NAME` — observability only; the operator keys off the workload it reconciled. */
  readonly node: string;
  /** Every tag in the image's migration journal, in journal order. */
  readonly declared: readonly string[];
  /** Every row drizzle actually has in its ledger, oldest first. */
  readonly applied: readonly AppliedMigration[];
}

function isAppliedMigration(value: unknown): value is AppliedMigration {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.tag === "string" &&
    row.tag.length > 0 &&
    typeof row.hash === "string" &&
    typeof row.appliedAtMs === "number" &&
    Number.isFinite(row.appliedAtMs)
  );
}

/**
 * Extract the LAST receipt from a migrator's stdout, or null when there is none.
 *
 * Last-wins because a Job pod may legitimately print several (the `migrate` phase and a future
 * phase both emit), and the most recent line is the one that describes the end state. A malformed
 * or truncated line is treated as ABSENT rather than as an empty applied set — see
 * `features/nodes/observability-db-schema`: silence must never read as "zero migrations applied".
 */
export function parseMigrationReceipt(stdout: string): MigrationReceipt | null {
  let found: MigrationReceipt | null = null;
  for (const line of stdout.split("\n")) {
    const at = line.indexOf(MIGRATION_RECEIPT_MARKER);
    if (at < 0) continue;
    const payload = line.slice(at + MIGRATION_RECEIPT_MARKER.length).trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const body = parsed as Record<string, unknown>;
    if (!Array.isArray(body.declared) || !Array.isArray(body.applied)) continue;
    if (!body.declared.every((tag) => typeof tag === "string")) continue;
    if (!body.applied.every(isAppliedMigration)) continue;
    found = {
      node: typeof body.node === "string" ? body.node : "unknown",
      declared: body.declared as readonly string[],
      applied: body.applied as readonly AppliedMigration[],
    };
  }
  return found;
}

/** Declared-vs-applied drift — the comparison the loud gate is built on. */
export interface MigrationDrift {
  /** Declared in the image's journal, absent from the database. A migration that did not arrive. */
  readonly missing: readonly string[];
  /** Applied in the database, absent from the image's journal. An image rolled BACK past its schema. */
  readonly unexpected: readonly string[];
}

/**
 * Compare what the image declares against what the database holds.
 *
 * `missing` is the loud half: a non-empty `missing` means a developer's migration is in the image
 * and not in the database, which is exactly the "did my migration land?" question — answerable
 * without SSH, without a box, and without anyone holding a cross-node database credential.
 */
export function diffDeclaredVsApplied(input: {
  readonly declared: readonly string[];
  readonly applied: readonly { readonly tag: string }[];
}): MigrationDrift {
  const appliedTags = new Set(input.applied.map((row) => row.tag));
  const declaredTags = new Set(input.declared);
  return {
    missing: input.declared.filter((tag) => !appliedTags.has(tag)),
    unexpected: input.applied
      .map((row) => row.tag)
      .filter((tag) => !declaredTags.has(tag)),
  };
}

/**
 * THE gate predicate, stated once so every consumer agrees: a drift fails only when a DECLARED
 * migration did not arrive.
 *
 * Absent drift (`null`/`undefined`) is NOT a failure. There is no drift to read when no receipt
 * was ever collected — a node whose image predates the emitter, or whose Job log could not be
 * read — and an unknown must never be laundered into a verdict. `unexpected` alone is likewise
 * NOT a failure: an applied row the journal does not recognise is drift worth shouting about, but
 * it is not "a declared migration did not arrive", and blocking on it would fail every node whose
 * image is legitimately older than a row in its own ledger.
 */
export function hasMissingMigrations(
  drift: MigrationDrift | null | undefined
): boolean {
  return (drift?.missing.length ?? 0) > 0;
}
