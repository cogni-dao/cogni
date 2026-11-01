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
import { actorDatabaseAwait } from "./akash-actor-scope";
import {
  advanceReceiptVersion,
  receiptFence,
  receiptTransaction,
} from "./akash-receipt-transaction";

export class DrizzleDatabaseCellBindingStore {
  constructor(
    private readonly database: () => Promise<Database>,
    private readonly walletScope: string
  ) {}

  /** Raw capabilities stay inside these concrete operation implementations. */
  async #withDatabase<T>(
    deadlineAt: number | undefined,
    operation: (db: Database) => Promise<T>
  ): Promise<T> {
    const db = await actorDatabaseAwait(this.database, deadlineAt);
    return actorDatabaseAwait(() => operation(db), deadlineAt);
  }

  async read(
    cogniKey: string,
    deadlineAt?: number
  ): Promise<readonly AppliedDatabaseCellReceipt[]> {
    return this.#withDatabase(deadlineAt, async (db) => {
      const rows = await actorDatabaseAwait(() =>
        db
          .select({ bindings: akashTxAllocations.appliedDatabaseCellBinding })
          .from(akashTxAllocations)
          .where(
            and(
              eq(akashTxAllocations.walletScope, this.walletScope),
              eq(akashTxAllocations.cogniKey, cogniKey)
            )
          )
          .limit(1)
      );
      if (!rows[0]) throw new Error("cell allocation receipt absent");
      return DatabaseCellAllocationMetadataSchema.parse(rows[0].bindings ?? [])
        .bindings;
    });
  }

  async save(
    record: AkashTxAllocationRecord,
    bindings: readonly AppliedDatabaseCellReceipt[],
    expected: readonly AppliedDatabaseCellReceipt[],
    deadlineAt?: number
  ): Promise<void> {
    return this.#withDatabase(deadlineAt, async (db) => {
      const validated = AppliedDatabaseCellReceiptsSchema.parse(bindings);
      if (
        !record.externalName ||
        !record.providerAccount ||
        !record.lastAppliedSdlHash ||
        validated.some(
          ({ allocationEnvironment, binding }) =>
            allocationEnvironment !== record.environment ||
            binding.receiptId !== record.receiptId ||
            binding.cogniKey !== record.cogniKey ||
            binding.nodeId !== record.identity.nodeId ||
            binding.dseq !== record.externalName ||
            binding.providerAccount !== record.providerAccount ||
            binding.appliedSdlHash !== record.lastAppliedSdlHash
        )
      )
        throw new Error("cell allocation is not applied");
      const providerAccount = record.providerAccount;
      const appliedSdlHash = record.lastAppliedSdlHash;
      await actorDatabaseAwait(() =>
        receiptTransaction(
          db,
          async (tx) => {
            const predicate = and(
              receiptFence(this.walletScope, record.cogniKey, record),
              eq(akashTxAllocations.providerAccount, providerAccount),
              eq(akashTxAllocations.lastAppliedSdlHash, appliedSdlHash),
              eq(akashTxAllocations.state, "allocated"),
              sql`coalesce(${akashTxAllocations.appliedDatabaseCellBinding}->'bindings', ${akashTxAllocations.appliedDatabaseCellBinding}, '[]'::jsonb) = ${JSON.stringify(expected)}::jsonb`
            );
            const [current] = await actorDatabaseAwait(() =>
              tx
                .select({
                  metadata: akashTxAllocations.appliedDatabaseCellBinding,
                })
                .from(akashTxAllocations)
                .where(predicate)
                .for("update")
                .limit(1)
            );
            if (!current)
              throw new Error(
                "cell allocation changed during binding compare-and-swap"
              );
            const metadata = DatabaseCellAllocationMetadataSchema.parse(
              current.metadata ?? []
            );
            if (
              metadata.retentionPolicy === "retain" &&
              JSON.stringify(metadata.bindings) === JSON.stringify(validated)
            )
              return;
            const updated = await actorDatabaseAwait(() =>
              tx
                .update(akashTxAllocations)
                .set({
                  appliedDatabaseCellBinding: {
                    version: 1,
                    retentionPolicy: "retain",
                    bindings: validated,
                  },
                  updatedAt: advanceReceiptVersion,
                })
                .where(predicate)
                .returning({ id: akashTxAllocations.id })
            );
            if (updated.length !== 1)
              throw new Error(
                "cell allocation changed during binding compare-and-swap"
              );
          },
          deadlineAt
        )
      );
    });
  }
}
