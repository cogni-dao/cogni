// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@types/migration-receipt`
 * Purpose: The applied-migration row type, placed where both `ports` and `shared` may import it.
 * Scope: One pure interface; carries no runtime code, no parsing, and not any policy about drift.
 * Invariants:
 *   - BOTTOM_OF_TREE: `ports → types` and `shared → types` are both allowed, while
 *     `ports → shared` is not — so a type the port contract and the wire parser must agree on
 *     belongs here, never in one of them.
 * Side-effects: none
 * Links: shared/migrations/migration-receipt.ts, ports/node-migration-report.port.ts
 * @public
 */

/** One row of drizzle's applied-migration ledger, joined to its journal tag. */
export interface AppliedMigration {
  /** Journal tag, e.g. `0050_oval_madripoor`. Resolved by the migrator from `meta/_journal.json`. */
  readonly tag: string;
  /** drizzle's own hash of the migration SQL, as recorded in `drizzle.__drizzle_migrations`. */
  readonly hash: string;
  /** drizzle's `created_at` for the row (the journal's `when`, epoch ms). */
  readonly appliedAtMs: number;
}
