// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/compute/database-cell-binding-store.adapter`
 * Purpose: Store verified logical cell bindings on their existing paid allocation row.
 * Scope: Allocation metadata reads and guarded updates; does not allocate compute or hold cell credentials.
 * Invariants: Receipt identity, provider, handle and applied SDL remain unchanged during the binding transaction.
 * Side-effects: IO (Postgres)
 * Links: shared/db/akash-tx-allocations.ts, features/compute/akash-tx/database-cell-binding.ts
 * @internal
 */
import type { Database } from "@cogni/db-client";
import { and, eq, sql } from "drizzle-orm";

import type { AkashTxAllocationRecord } from "@/ports";
import { akashTxAllocations } from "@/shared/db/schema";
import {
  type AppliedDatabaseCellReceipt,
  AppliedDatabaseCellReceiptsSchema,
  DatabaseCellAllocationMetadataSchema,
} from "@/shared/secrets/database-cell-placement.data";

export class DrizzleDatabaseCellBindingStore {
  constructor(
    private readonly getDb: () => Promise<Database>,
    private readonly walletScope: string
  ) {}

  async read(cogniKey: string): Promise<readonly AppliedDatabaseCellReceipt[]> {
    const db = await this.getDb();
    const rows = await db
      .select({ bindings: akashTxAllocations.appliedDatabaseCellBinding })
      .from(akashTxAllocations)
      .where(
        and(
          eq(akashTxAllocations.walletScope, this.walletScope),
          eq(akashTxAllocations.cogniKey, cogniKey)
        )
      )
      .limit(1);
    if (!rows[0]) throw new Error("cell allocation receipt absent");
    return DatabaseCellAllocationMetadataSchema.parse(rows[0].bindings ?? [])
      .bindings;
  }

  async save(
    record: AkashTxAllocationRecord,
    bindings: readonly AppliedDatabaseCellReceipt[],
    expected: readonly AppliedDatabaseCellReceipt[]
  ): Promise<void> {
    const validated = AppliedDatabaseCellReceiptsSchema.parse(bindings);
    if (
      !record.externalName ||
      !record.providerAccount ||
      !record.lastAppliedSdlHash
    )
      throw new Error("cell allocation is not applied");
    const db = await this.getDb();
    const updated = await db
      .update(akashTxAllocations)
      .set({
        appliedDatabaseCellBinding: {
          version: 1,
          retentionPolicy: "retain",
          bindings: validated,
        },
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(akashTxAllocations.walletScope, this.walletScope),
          eq(akashTxAllocations.id, record.receiptId),
          eq(akashTxAllocations.cogniKey, record.cogniKey),
          eq(akashTxAllocations.nodeId, record.identity.nodeId),
          eq(akashTxAllocations.environment, record.environment),
          eq(akashTxAllocations.state, "allocated"),
          eq(akashTxAllocations.externalName, record.externalName),
          eq(akashTxAllocations.providerAccount, record.providerAccount),
          eq(akashTxAllocations.lastAppliedSdlHash, record.lastAppliedSdlHash),
          sql`coalesce(${akashTxAllocations.appliedDatabaseCellBinding}->'bindings', ${akashTxAllocations.appliedDatabaseCellBinding}, '[]'::jsonb) = ${JSON.stringify(expected)}::jsonb`
        )
      )
      .returning({ id: akashTxAllocations.id });
    if (updated.length !== 1)
      throw new Error("cell allocation changed during native sealing");
  }
}
