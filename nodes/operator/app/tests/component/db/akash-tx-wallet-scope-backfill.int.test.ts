// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/akash-tx-wallet-scope-backfill.int`
 * Purpose: Prove the bug.5187 cutover cannot double-spend. `wallet_scope` is HALF the key
 *   `claimOnce` looks a prior receipt up by — `(wallet_scope, cogni_key)` — so re-deriving it
 *   from the Console account instead of the environment hides every existing receipt unless the
 *   rows move in the same change. A hidden receipt makes the reconciler conclude "nothing was
 *   ever created" and mint a SECOND PAID LEASE beside one that is still billing.
 * Scope: Replays the committed 0048 migration against a REAL Postgres holding legacy env-keyed
 *   receipts, then asks the ledger adapter the exact question the reconciler asks. Touches no
 *   Akash Console, no wallet and no provider.
 * Invariants: RECEIPT_SURVIVES_THE_CUTOVER, NO_PREPARING_ROW_IS_REWRITTEN,
 *   ROW_COUNTS_ARE_ASSERTED, LEGACY_SCOPE_IS_UNWRITABLE_AFTERWARDS.
 * Side-effects: IO (Postgres via testcontainers; drops and re-adds the account-scope CHECK
 *   inside a transaction, so a rollback restores the schema exactly). Connects as `app_user`
 *   (DATABASE_URL) rather than the seed/service role, because only the DB OWNER may ALTER the
 *   table — and `app_user` is exactly the role the migrator itself runs as in production.
 * Links: src/adapters/server/db/migrations/0048_complex_sister_grimm.sql,
 *   src/adapters/server/compute/akash-tx-allocation-ledger.adapter.ts,
 *   src/features/compute/akash-tx/akash-tx-wallet.ts, bug.5187
 * @internal
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { createAppDbClient, type Database } from "@cogni/db-client";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { DrizzleAkashTxAllocationLedger } from "@/adapters/server/compute/akash-tx-allocation-ledger.adapter";
import { accountWalletScope } from "@/features/compute/akash-tx/akash-tx-wallet";
import { akashTxAllocations } from "@/shared/db/schema";

/**
 * The REAL pins, because the migration's env->account map is exhaustive rather than
 * parameterised and this test is what proves that map is the one the code derives. Both values
 * are public, non-secret Akash addresses already committed in
 * `infra/k8s/overlays/<env>/operator/kustomization.yaml`.
 */
const PRODUCTION_ACCOUNT = "akash10auj6u6wr7aqjawuxurgue9w7wfnca50t8cr4l";
const CANDIDATE_ACCOUNT = "akash12eh8xgpeyumar3sk6wp94y0tq9uh62mkezxjmt";

const LEGACY_PRODUCTION_SCOPE = "akash-console:production";
const LEGACY_CANDIDATE_SCOPE = "akash-console:candidate-a";

const CONSTRAINT = "akash_tx_allocations_wallet_scope_account_check";

const NODE_ID = "5a2f9c41-77d0-4b3e-9f21-6c8e0a1b2d34";
const IDENTITY = {
  nodeId: NODE_ID,
  compositeUid: "b71c0d92-1e34-4a56-8f7b-0c9d8e7f6a51",
  compositeGeneration: 2,
};

/**
 * The MIGRATOR's own role. `DATABASE_SERVICE_URL` (the usual component-test seed client) is
 * `app_service` — BYPASSRLS but NOT the table owner, so every `ALTER TABLE` here fails with
 * `42501 must be owner of table`. Migrations run as `app_user` in CI and in production alike,
 * which is what makes replaying a real migration from a test legitimate rather than a
 * privilege the deployed system does not have.
 */
function ownerDb(): Database {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL not set. Run via the component vitest config (pnpm test:component)."
    );
  }
  return createAppDbClient(url);
}

const MIGRATIONS_DIR = path.resolve(
  __dirname,
  "../../../src/adapters/server/db/migrations"
);

/** The committed 0048 body, split exactly the way drizzle's migrator splits it. */
function backfillStatements(): string[] {
  const file = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .find((name) =>
      readFileSync(path.join(MIGRATIONS_DIR, name), "utf8").includes(CONSTRAINT)
    );
  if (!file) throw new Error(`no committed migration adds ${CONSTRAINT}`);
  return readFileSync(path.join(MIGRATIONS_DIR, file), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/**
 * Apply the migration the way the migrator does: every statement inside ONE transaction, on a
 * database that still looks pre-cutover. Dropping the CHECK first is what makes the database
 * pre-cutover — it is re-added by the migration's own final statement, so a committed run
 * leaves the schema exactly as it found it and a raised run rolls the drop back too.
 */
async function applyBackfill(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql.raw(
        `ALTER TABLE "akash_tx_allocations" DROP CONSTRAINT "${CONSTRAINT}"`
      )
    );
    for (const statement of backfillStatements()) {
      await tx.execute(sql.raw(statement));
    }
  });
}

/** Seed a row the CHECK would normally forbid, by lifting it for exactly that insert. */
async function seedLegacyRow(
  db: Database,
  row: {
    walletScope: string;
    cogniKey: string;
    environment: string;
    state: string;
    externalName?: string;
    allocationCursor?: string;
  }
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql.raw(
        `ALTER TABLE "akash_tx_allocations" DROP CONSTRAINT "${CONSTRAINT}"`
      )
    );
    await tx.insert(akashTxAllocations).values({
      walletScope: row.walletScope,
      cogniKey: row.cogniKey,
      nodeId: IDENTITY.nodeId,
      compositeUid: IDENTITY.compositeUid,
      compositeGeneration: IDENTITY.compositeGeneration,
      workload: "toks4",
      environment: row.environment,
      state: row.state,
      ...(row.externalName ? { externalName: row.externalName } : {}),
      ...(row.allocationCursor
        ? { allocationCursor: row.allocationCursor }
        : {}),
    });
    await tx.execute(
      sql.raw(
        `ALTER TABLE "akash_tx_allocations" ADD CONSTRAINT "${CONSTRAINT}" CHECK ("akash_tx_allocations"."wallet_scope" ~ '^akash-console:akash1[0-9a-z]{38}$') NOT VALID`
      )
    );
  });
}

describe("bug.5187 wallet_scope backfill (Component)", () => {
  const db = ownerDb();

  afterEach(async () => {
    // Leave the table as the other component tests expect: no rows of ours, constraint VALID.
    for (const scope of [
      LEGACY_PRODUCTION_SCOPE,
      LEGACY_CANDIDATE_SCOPE,
      accountWalletScope(PRODUCTION_ACCOUNT),
      accountWalletScope(CANDIDATE_ACCOUNT),
    ]) {
      await db
        .delete(akashTxAllocations)
        .where(eq(akashTxAllocations.walletScope, scope));
    }
    await db.execute(
      sql.raw(
        `ALTER TABLE "akash_tx_allocations" VALIDATE CONSTRAINT "${CONSTRAINT}"`
      )
    );
  });

  /**
   * THE REGRESSION. A production receipt written under `akash-console:production` — an allocated
   * lease that is still billing — must still be found by the account-keyed writer afterwards.
   * `claimOnce` answering `settled` with the stored handle is exactly "replay, spend nothing";
   * answering `claimed` would be the double-spend.
   */
  it("a receipt written under the OLD scope is still found by claimOnce after the migration", async () => {
    await seedLegacyRow(db, {
      walletScope: LEGACY_PRODUCTION_SCOPE,
      cogniKey: "xcw:cogni-production:toks4:0",
      environment: "production",
      state: "allocated",
      externalName: "7421",
    });

    await applyBackfill(db);

    const ledger = new DrizzleAkashTxAllocationLedger(
      async () => db,
      accountWalletScope(PRODUCTION_ACCOUNT)
    );
    const claim = await ledger.claim({
      cogniKey: "xcw:cogni-production:toks4:0",
      workload: "toks4",
      environment: "production",
      identity: IDENTITY,
    });

    expect(claim.state).toBe("settled");
    expect(
      claim.state === "settled" ? claim.record.externalName : undefined
    ).toBe("7421");
  });

  it("maps EACH environment's rows to that environment's own account", async () => {
    await seedLegacyRow(db, {
      walletScope: LEGACY_CANDIDATE_SCOPE,
      cogniKey: "xcw:cogni-candidate-a:toks4:0",
      environment: "candidate-a",
      state: "allocated",
      externalName: "7100",
    });
    await seedLegacyRow(db, {
      walletScope: LEGACY_PRODUCTION_SCOPE,
      cogniKey: "xcw:cogni-production:toks4:0",
      environment: "production",
      state: "released",
    });

    await applyBackfill(db);

    const scopes = await db
      .select({
        cogniKey: akashTxAllocations.cogniKey,
        walletScope: akashTxAllocations.walletScope,
      })
      .from(akashTxAllocations)
      .where(eq(akashTxAllocations.nodeId, NODE_ID));

    expect(
      Object.fromEntries(scopes.map((row) => [row.cogniKey, row.walletScope]))
    ).toEqual({
      "xcw:cogni-candidate-a:toks4:0": accountWalletScope(CANDIDATE_ACCOUNT),
      "xcw:cogni-production:toks4:0": accountWalletScope(PRODUCTION_ACCOUNT),
    });
  });

  /**
   * NO_PREPARING_ROW_IS_REWRITTEN. A `preparing` row is a writer mid-spend: its cursor is
   * durable and the Console POST may already have been paid for. Moving its scope would orphan
   * the only evidence that recovers a lost response, so the migration refuses the whole deploy
   * rather than rewriting it. Production held zero preparing rows at cutover — enforced here,
   * not assumed.
   */
  it("REFUSES to run while a legacy row is mid-spend, and rewrites nothing", async () => {
    await seedLegacyRow(db, {
      walletScope: LEGACY_PRODUCTION_SCOPE,
      cogniKey: "xcw:cogni-production:toks4:1",
      environment: "production",
      state: "preparing",
      allocationCursor: "7400",
    });

    await expect(applyBackfill(db)).rejects.toThrow(/state=.preparing./);

    const [row] = await db
      .select({ walletScope: akashTxAllocations.walletScope })
      .from(akashTxAllocations)
      .where(eq(akashTxAllocations.nodeId, NODE_ID));
    expect(row?.walletScope).toBe(LEGACY_PRODUCTION_SCOPE);
  });

  /**
   * LEGACY_SCOPE_IS_UNWRITABLE_AFTERWARDS — the other deploy direction. A writer still running
   * the old code after the backfill lands cannot open a second serialization domain on the same
   * account: its claiming INSERT is rejected by the database, so it fails loudly and spends
   * nothing instead of paying twice.
   */
  it("makes the legacy environment-keyed scope unwritable once applied", async () => {
    await expect(
      db.insert(akashTxAllocations).values({
        walletScope: LEGACY_PRODUCTION_SCOPE,
        cogniKey: "xcw:cogni-production:toks4:2",
        nodeId: IDENTITY.nodeId,
        compositeUid: IDENTITY.compositeUid,
        compositeGeneration: IDENTITY.compositeGeneration,
        workload: "toks4",
        environment: "production",
        state: "preparing",
      })
    ).rejects.toThrow(/akash_tx_allocations_wallet_scope_account_check/);
  });
});
