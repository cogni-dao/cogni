// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/compute/database-cell-binding-store.adapter`
 * Purpose: Persist verified bindings or atomically import physical recovery lineage.
 * Scope: Allocation metadata reads and guarded updates; does not allocate compute or hold cell credentials.
 * Invariants: One applied authority; immutable paid identities; physical imports adopt only verified known postimages.
 * Side-effects: IO (Postgres)
 * Links: shared/db/akash-tx-allocations.ts, features/compute/akash-tx/database-cell-binding.ts
 * @internal
 */
import type { Database } from "@cogni/db-client";
import { and, eq, sql } from "drizzle-orm";
import type {
  AkashTxAllocationRecord,
  DatabaseCellPhysicalRecoveryWrite,
} from "@/ports";
import { AkashTxError } from "@/ports";
import { akashTxAllocations } from "@/shared/db/schema";
import {
  type AppliedDatabaseCellReceipt,
  AppliedDatabaseCellReceiptsSchema,
  DatabaseCellAllocationMetadataSchema,
  physicalSourceBindingSha256,
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
      [...expected, ...validated].some(
        (receipt) => receipt.binding.phase === "superseded"
      )
    )
      throw new AkashTxError(
        "identity_conflict",
        "ordinary binding cannot rewrite physical recovery history"
      );
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
    const { externalName, providerAccount, lastAppliedSdlHash } = record;
    const db = await this.getDb();
    try {
      await db.transaction(
        async (tx) => {
          // Predicate shared with physical import: concurrent inserts must not install a
          // second authority, even when no row for that allocation existed at snapshot.
          const scope = await tx
            .select()
            .from(akashTxAllocations)
            .where(
              and(
                eq(akashTxAllocations.walletScope, this.walletScope),
                eq(akashTxAllocations.nodeId, record.identity.nodeId),
                eq(akashTxAllocations.environment, record.environment),
                eq(akashTxAllocations.state, "allocated")
              )
            )
            .orderBy(akashTxAllocations.id)
            .for("update");
          const others = scope.flatMap((row) =>
            row.id === record.receiptId
              ? []
              : DatabaseCellAllocationMetadataSchema.parse(
                  row.appliedDatabaseCellBinding ?? []
                ).bindings.filter(
                  (receipt) => receipt.binding.phase === "applied"
                )
          );
          if (
            validated.some(
              (receipt) =>
                receipt.binding.phase === "applied" &&
                others.some(
                  (other) =>
                    other.binding.environment === receipt.binding.environment
                )
            )
          )
            throw new Error(
              "cell already has an authoritative applied allocation"
            );
          const updated = await tx
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
                eq(akashTxAllocations.externalName, externalName),
                eq(akashTxAllocations.providerAccount, providerAccount),
                eq(akashTxAllocations.lastAppliedSdlHash, lastAppliedSdlHash),
                sql`coalesce(${akashTxAllocations.appliedDatabaseCellBinding}->'bindings', ${akashTxAllocations.appliedDatabaseCellBinding}, '[]'::jsonb) = ${JSON.stringify(expected)}::jsonb`
              )
            )
            .returning({ id: akashTxAllocations.id });
          if (updated.length !== 1)
            throw new Error(
              "cell allocation changed during binding compare-and-swap"
            );
        },
        { isolationLevel: "serializable" }
      );
    } catch {
      throw new AkashTxError(
        "identity_conflict",
        "cell binding changed; reread before retry"
      );
    }
  }

  async savePhysicalRecovery(
    input: DatabaseCellPhysicalRecoveryWrite
  ): Promise<void> {
    const targetBindings = AppliedDatabaseCellReceiptsSchema.parse(
      input.targetBindings
    );
    const target = targetBindings.find(
      (receipt) => receipt.binding.environment === "production"
    );
    const lineage = target?.registration?.physicalRecovery;
    if (
      !target ||
      !lineage ||
      targetBindings.length !== 1 ||
      input.target.cogniKey !== input.recoveryIntentKey ||
      target.binding.phase !== "applied" ||
      target.binding.appliedSdlHash !== input.targetSdlHash ||
      target.registration?.appSdlHash !== input.appSdlHash ||
      target.registration?.appAllocationReceiptId !== input.app.receiptId ||
      target.binding.cutover?.packetSha256 !== input.packetSha256 ||
      lineage.sourceReceiptId !== input.source.receiptId ||
      lineage.sourceCogniKey !== input.source.cogniKey ||
      lineage.sourceDseq !== input.source.externalName ||
      new Set([
        input.source.receiptId,
        input.target.receiptId,
        input.app.receiptId,
      ]).size !== 3 ||
      new Set([
        input.source.externalName,
        input.target.externalName,
        input.app.externalName,
      ]).size !== 3 ||
      input.source.retentionPolicy !== "retain" ||
      input.target.retentionPolicy !== "retain"
    )
      throw new AkashTxError(
        "identity_conflict",
        "physical recovery lineage is not an owned retained transition"
      );
    const db = await this.getDb();
    try {
      await db.transaction(
        async (tx) => {
          const rows = await tx
            .select()
            .from(akashTxAllocations)
            .where(
              and(
                eq(akashTxAllocations.walletScope, this.walletScope),
                eq(akashTxAllocations.nodeId, input.target.identity.nodeId),
                eq(akashTxAllocations.environment, input.target.environment),
                eq(akashTxAllocations.state, "allocated")
              )
            )
            .orderBy(akashTxAllocations.id)
            .for("update");
          const snapshot = (record: AkashTxAllocationRecord) => {
            const row = rows.find(
              (candidate) => candidate.id === record.receiptId
            );
            if (
              !row ||
              row.cogniKey !== record.cogniKey ||
              row.nodeId !== record.identity.nodeId ||
              row.compositeUid !== record.identity.compositeUid ||
              row.compositeGeneration !== record.identity.compositeGeneration ||
              row.environment !== record.environment ||
              row.workload !== record.workload ||
              row.externalName !== record.externalName ||
              row.providerAccount !== record.providerAccount ||
              row.lastAppliedSdlHash !== record.lastAppliedSdlHash
            )
              throw new Error("physical recovery allocation preimage changed");
            return row;
          };
          const sourceRow = snapshot(input.source),
            targetRow = snapshot(input.target),
            appRow = snapshot(input.app);
          const source = DatabaseCellAllocationMetadataSchema.parse(
            sourceRow.appliedDatabaseCellBinding ?? []
          );
          const existingTarget = DatabaseCellAllocationMetadataSchema.parse(
            targetRow.appliedDatabaseCellBinding ?? []
          );
          if (
            source.retentionPolicy !== "retain" ||
            existingTarget.retentionPolicy !== "retain" ||
            JSON.stringify(source.bindings) !==
              JSON.stringify(input.expectedSource) ||
            JSON.stringify(existingTarget.bindings) !==
              JSON.stringify(input.expectedTarget) ||
            target.binding.receiptId !== targetRow.id ||
            target.binding.cogniKey !== targetRow.cogniKey ||
            target.binding.nodeId !== targetRow.nodeId ||
            target.binding.dseq !== targetRow.externalName ||
            target.binding.providerAccount !== targetRow.providerAccount
          )
            throw new Error("physical recovery binding preimage changed");
          const authorities = rows.flatMap((row) =>
            DatabaseCellAllocationMetadataSchema.parse(
              row.appliedDatabaseCellBinding ?? []
            ).bindings.filter(
              (receipt) =>
                receipt.binding.environment === "production" &&
                receipt.binding.phase === "applied"
            )
          );
          const old = source.bindings.find(
            (receipt) => receipt.binding.environment === "production"
          );
          if (
            !old ||
            source.bindings.length !== 1 ||
            old.binding.systemIdentifier !== target.binding.systemIdentifier ||
            physicalSourceBindingSha256(old) !== lineage.sourceBindingSha256
          )
            throw new Error("physical source identity changed");
          if (
            old.binding.phase === "superseded" &&
            old.binding.supersededBy?.receiptId === targetRow.id &&
            old.binding.supersededBy.packetSha256 === input.packetSha256 &&
            authorities.length === 1 &&
            authorities[0]?.binding.receiptId === targetRow.id &&
            JSON.stringify(existingTarget.bindings) ===
              JSON.stringify(targetBindings) &&
            targetRow.lastAppliedSdlHash === input.targetSdlHash &&
            appRow.lastAppliedSdlHash === input.appSdlHash
          )
            return; // Exact terminal replay after fresh native observations; no timestamps rewritten.
          if (
            old.binding.phase !== "applied" ||
            authorities.length !== 1 ||
            authorities[0]?.binding.receiptId !== sourceRow.id ||
            existingTarget.bindings.length !== 0
          )
            throw new Error(
              "physical recovery requires exactly one original authority"
            );
          if (
            lineage.originalAppliedSdlHashes.source !==
              sourceRow.lastAppliedSdlHash ||
            lineage.originalAppliedSdlHashes.target !==
              targetRow.lastAppliedSdlHash ||
            lineage.originalAppliedSdlHashes.app !== appRow.lastAppliedSdlHash
          )
            throw new Error(
              "physical original anchors differ from independent canonical preimages"
            );
          const superseded = AppliedDatabaseCellReceiptsSchema.parse(
            source.bindings.map((receipt) => ({
              ...receipt,
              binding: {
                ...receipt.binding,
                phase: "superseded",
                supersededBy: {
                  receiptId: targetRow.id,
                  packetSha256: input.packetSha256,
                },
              },
            }))
          );
          await tx
            .update(akashTxAllocations)
            .set({
              appliedDatabaseCellBinding: {
                version: 1,
                retentionPolicy: "retain",
                bindings: superseded,
              },
              updatedAt: sql`now()`,
            })
            .where(eq(akashTxAllocations.id, sourceRow.id));
          await tx
            .update(akashTxAllocations)
            .set({
              appliedDatabaseCellBinding: {
                version: 1,
                retentionPolicy: "retain",
                bindings: targetBindings,
              },
              lastAppliedSdlHash: input.targetSdlHash,
              updatedAt: sql`now()`,
            })
            .where(eq(akashTxAllocations.id, targetRow.id));
          await tx
            .update(akashTxAllocations)
            .set({
              lastAppliedSdlHash: input.appSdlHash,
              updatedAt: sql`now()`,
            })
            .where(eq(akashTxAllocations.id, appRow.id));
        },
        { isolationLevel: "serializable" }
      );
    } catch {
      // Serialization/deadlock/CAS failures require fresh evidence, never a native retry.
      throw new AkashTxError(
        "identity_conflict",
        "physical recovery preimage changed; reobserve before retry"
      );
    }
  }
}
