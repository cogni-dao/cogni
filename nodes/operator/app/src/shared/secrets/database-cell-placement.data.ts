// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/secrets/database-cell-placement.data`
 * Purpose: Bind a logical database's native incident to its truthful physical allocation receipt.
 * Scope: Pure schemas and types; does not allocate resources or authorize cutover.
 * Invariants: Physical allocation environment and operator source remain separate from logical environment and app build.
 * Side-effects: none
 * Links: shared/secrets/database-cell-binding.data.ts, shared/db/akash-tx-allocations.ts
 * @internal
 */
import { z } from "zod";
import type { DatabaseCellAppliedRegistrationFacts } from "@/types/database-cell";

import { DatabaseCellBindingSchema } from "./database-cell-binding.data";

export const AppliedDatabaseCellReceiptSchema = z
  .object({
    allocationEnvironment: z.enum(["candidate-a", "preview", "production"]),
    targetBuildSha: z.string().regex(/^[0-9a-f]{40}$/),
    initialIncidentId: z.string().min(1).max(256).optional(),
    registration: z
      .object({
        kind: z.literal("audited-manual"),
        readmissionReceiptId: z.string().min(1).max(256),
        manualCutoverPacketSha256: z.string().regex(/^[0-9a-f]{64}$/),
        scheduledBackupReceiptSha256: z.string().regex(/^[0-9a-f]{64}$/),
        independentRecoveryReceiptSha256: z.string().regex(/^[0-9a-f]{64}$/),
        appAllocationReceiptId: z.string().uuid(),
        appSdlHash: z.string().regex(/^[0-9a-f]{64}$/),
        migrationConsumer: z.enum([
          "app-database-url",
          "dedicated-migration-url",
        ]),
        tlsTrustKind: z.enum(["system", "private-ca"]),
        registeredAt: z.string().datetime({ offset: true }),
      })
      .strict()
      .optional(),
    binding: DatabaseCellBindingSchema,
  })
  .strict()
  .superRefine((receipt, ctx) => {
    if (
      receipt.registration
        ? receipt.initialIncidentId !== undefined ||
          receipt.binding.phase !== "applied" ||
          receipt.registration.manualCutoverPacketSha256 !==
            receipt.binding.cutover?.packetSha256
        : !receipt.initialIncidentId
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "receipt requires a genuine native incident or explicit audited manual registration",
      });
    }
  });
export const AppliedDatabaseCellReceiptsSchema = z
  .array(AppliedDatabaseCellReceiptSchema)
  .max(3)
  .superRefine((receipts, ctx) => {
    const seen = new Set<string>();
    for (const receipt of receipts) {
      const identity = `${receipt.binding.nodeId}/${receipt.binding.environment}`;
      if (seen.has(identity)) {
        ctx.addIssue({
          code: "custom",
          message: "duplicate logical cell receipt",
        });
      }
      seen.add(identity);
    }
  });
export type { AppliedDatabaseCellReceipt } from "@/types/database-cell";

/** The existing JSON allocation column owns lifecycle as well as native bindings. */
export const DatabaseCellAllocationMetadataSchema = z.union([
  z
    .object({
      version: z.literal(1),
      retentionPolicy: z.literal("retain"),
      bindings: AppliedDatabaseCellReceiptsSchema,
    })
    .strict(),
  // Existing sealed cells must already be protected before the metadata is upgraded.
  AppliedDatabaseCellReceiptsSchema.transform((bindings) => ({
    version: 1 as const,
    retentionPolicy: bindings.length ? ("retain" as const) : undefined,
    bindings,
  })),
]);

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const sourceSha = z.string().regex(/^[0-9a-f]{40}$/);
const timestamp = z.string().datetime({ offset: true });
const systemIdentifier = z.string().regex(/^[0-9]+$/);
const endpoint = z
  .object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    addresses: z.array(z.string().min(1)).min(1).max(32),
  })
  .strict();
const relations = z
  .array(z.string().regex(/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/))
  .min(1)
  .max(10000)
  .refine((values) => new Set(values).size === values.length);
const snapshotFingerprint = {
  fullSchemaFingerprintSha256: digest,
  fullDataFingerprintSha256: digest,
  sequenceStateFingerprintSha256: digest,
  relations,
  rowCount: z.string().regex(/^(0|[1-9][0-9]*)$/),
};

/** Validates measured adapter output; no request can supply this evidence bundle. */
export const DatabaseCellAppliedRegistrationFactsSchema = z
  .object({
    observedAt: timestamp,
    provider: z
      .object({
        dseq: systemIdentifier,
        providerAccount: z.string().regex(/^akash1[0-9a-z]{38}$/),
        appliedSdlHash: digest,
      })
      .strict(),
    native: z
      .object({
        databaseName: z.string().min(1),
        systemIdentifier,
        appRole: z.string().min(1),
        serviceRole: z.string().min(1),
        runtimeRoles: z
          .array(
            z
              .object({
                name: z.string().min(1),
                canLogin: z.boolean(),
                connectionLimit: z.number().int().min(-1),
              })
              .strict()
          )
          .min(2),
        activeRuntimeSessions: z.number().int().nonnegative(),
        serverVersionNum: z.number().int().min(150000).max(159999),
        tlsTrustKind: z.enum(["system", "private-ca"]),
        endpointIdentity: z
          .object({
            observedAt: timestamp,
            provider: endpoint,
            canonical: endpoint,
            peerCertificateDerSha256: digest,
            systemIdentifier,
          })
          .strict(),
      })
      .strict(),
    effectiveApp: z
      .object({
        allocationReceiptId: z.string().uuid(),
        deployedSourceSha: sourceSha,
        appliedSdlHash: digest,
        nodeId: z.string().uuid(),
        environment: z.literal("production"),
        appDsnSha256: digest,
        serviceDsnSha256: digest,
        migrationDsnSha256: digest,
        tlsCaSha256: digest.optional(),
        tlsTrustKind: z.enum(["system", "private-ca"]),
        migrationConsumer: z.enum([
          "app-database-url",
          "dedicated-migration-url",
        ]),
        readinessReceiptSha256: digest,
        regions: z
          .array(
            z
              .object({
                region: z.string().min(1),
                status: z.number().int(),
                buildSha: sourceSha,
                observedAt: timestamp,
              })
              .strict()
          )
          .min(2)
          .max(16),
      })
      .strict(),
    manualCutover: z
      .object({
        packetSha256: digest,
        purpose: z.literal("production-primary"),
        nodeId: z.string().uuid(),
        nodeSlug: z.string().min(1),
        environment: z.literal("production"),
        cellSourceSha: sourceSha,
        appAllocationReceiptId: z.string().uuid(),
        appSdlHash: digest,
        expectedRelations: relations,
        allocationReceiptId: z.string().uuid(),
        systemIdentifier,
        appSourceSha: sourceSha,
        sourceFenceReceiptSha256: digest,
        restorationParityManifestSha256: digest,
        authorizedActorId: z.string().regex(/^human:[a-zA-Z0-9._@:-]{1,120}$/),
        approvedAt: timestamp,
      })
      .strict(),
    readmission: z
      .object({
        receiptId: z.string().min(1).max(256),
        packetSha256: digest,
        allocationReceiptId: z.string().uuid(),
        systemIdentifier,
        admittedAt: timestamp,
        authorizedActorId: z.string().regex(/^human:[a-zA-Z0-9._@:-]{1,120}$/),
      })
      .strict(),
    scheduledBackup: z
      .object({
        receiptSha256: digest,
        databaseName: z.string().min(1),
        systemIdentifier,
        archiveSha256: digest,
        archiveBytes: z.number().int().positive(),
        snapshotStartedAt: timestamp,
        completedAt: timestamp,
        verifiedArchiveReceiptSha256: digest,
        schedulerUnitSha256: digest,
        executorFailureDomainId: z.string().min(1),
        ...snapshotFingerprint,
      })
      .strict(),
    independentRecovery: z
      .object({
        receiptSha256: digest,
        archiveSha256: digest,
        restoredSystemIdentifier: systemIdentifier,
        providerAccount: z.string().regex(/^akash1[0-9a-z]{38}$/),
        dseq: systemIdentifier,
        recoveryFailureDomainId: z.string().min(1),
        completedAt: timestamp,
        ...snapshotFingerprint,
      })
      .strict(),
  })
  .strict() satisfies z.ZodType<DatabaseCellAppliedRegistrationFacts>;
