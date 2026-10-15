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
import { createHash } from "node:crypto";
import { z } from "zod";
import type { DatabaseCellAppliedRegistrationFacts } from "@/types/database-cell";

import {
  DatabaseCellBindingSchema,
  DatabaseCellRoleBoundsSchema,
} from "./database-cell-binding.data";

const executionActor = z
  .object({ kind: z.enum(["agent", "human"]), id: z.string().uuid() })
  .strict();
const approvalAuthority = z
  .object({
    kind: z.literal("conversation-user"),
    label: z.literal("CEO"),
    humanAppUserId: z.string().uuid().nullable(),
    source: z.literal("direct-user-instruction"),
    decisionRef: z.string().min(1).max(2048),
    capturedAt: z.string().datetime({ offset: true }),
    delegationDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export const AppliedDatabaseCellReceiptSchema = z
  .object({
    allocationEnvironment: z.enum(["candidate-a", "preview", "production"]),
    targetBuildSha: z.string().regex(/^[0-9a-f]{40}$/),
    initialIncidentId: z.string().min(1).max(256).optional(),
    registration: z
      .object({
        kind: z.literal("audited-manual"),
        executionActor,
        approvalAuthority,
        readmissionReceiptId: z.string().min(1).max(256),
        manualCutoverPacketSha256: z.string().regex(/^[0-9a-f]{64}$/),
        scheduledBackupReceiptSha256: z.string().regex(/^[0-9a-f]{64}$/),
        independentRecoveryReceiptSha256: z.string().regex(/^[0-9a-f]{64}$/),
        appAllocationReceiptId: z.string().uuid(),
        appSdlHash: z.string().regex(/^[0-9a-f]{64}$/),
        appDsnSha256: z.string().regex(/^[0-9a-f]{64}$/),
        serviceDsnSha256: z.string().regex(/^[0-9a-f]{64}$/),
        migrationDsnSha256: z.string().regex(/^[0-9a-f]{64}$/),
        tlsCaSha256: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional(),
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
        : !receipt.initialIncidentId ||
          !receipt.binding.migrationRole ||
          !receipt.binding.probeRole
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

/** Measured current timer/service facts; no invented RPO policy or unconditional bound. */
export const DatabaseCellBackupRuntimeObservationSchema = z
  .object({
    observedAt: timestamp,
    timerActiveState: z.enum([
      "active",
      "inactive",
      "failed",
      "activating",
      "deactivating",
      "unknown",
    ]),
    nextRunAt: timestamp,
    intervalSeconds: z.number().int().positive(),
    jitterSeconds: z.number().int().nonnegative(),
    installedFullTimeoutSeconds: z.number().int().positive(),
    latestAttempt: z
      .object({
        startedAt: timestamp,
        completedAt: timestamp.nullable(),
        exitCode: z.number().int().nullable(),
      })
      .strict(),
    latestCompletedBackup: z
      .object({
        archiveSha256: digest,
        archiveBytes: z.number().int().positive(),
        snapshotStartedAt: timestamp,
        completedAt: timestamp,
        snapshotAgeSeconds: z.number().nonnegative(),
      })
      .strict(),
  })
  .strict() satisfies z.ZodType<
  import("@/types/database-cell").DatabaseCellBackupRuntimeObservation
>;

/** Honest conditional scheduling arithmetic. Failures/skips invalidate this window. */
export function assessDatabaseCellBackupRuntime(
  value: import("@/types/database-cell").DatabaseCellBackupRuntimeObservation
) {
  const runtime = DatabaseCellBackupRuntimeObservationSchema.parse(value);
  return {
    snapshotAgeSeconds: Math.max(
      0,
      (Date.parse(runtime.observedAt) -
        Date.parse(runtime.latestCompletedBackup.snapshotStartedAt)) /
        1000
    ),
    conditionalNominalWindowSeconds:
      runtime.intervalSeconds +
      runtime.jitterSeconds +
      runtime.installedFullTimeoutSeconds,
    assumptions: [
      "every scheduled run starts",
      "no failed, skipped or overlapping runs",
    ],
  };
}

/** Validates measured adapter output; no request can supply this evidence bundle. */
export const DatabaseCellAppliedRegistrationFactsSchema = z
  .object({
    observedAt: timestamp,
    backupRuntime: DatabaseCellBackupRuntimeObservationSchema,
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
            DatabaseCellRoleBoundsSchema.extend({
              canLogin: z.boolean(),
              roleReadOnly: z.boolean(),
            }).strict()
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
        preservedRoleBounds: z.array(DatabaseCellRoleBoundsSchema).length(2),
        allocationReceiptId: z.string().uuid(),
        systemIdentifier,
        appSourceSha: sourceSha,
        sourceFenceReceiptSha256: digest,
        restorationParityManifestSha256: digest,
        executionActor,
        approvalAuthority,
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
        executionActor,
        approvalAuthority,
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

/** The existing private bank authenticates custody; hashes verify exact frozen bytes.
 * This envelope is not a success proof. The producer must validate typed artifact
 * contents, links and live observations before returning registration facts.
 */
export const DatabaseCellAppliedEvidenceBundleSchema = z
  .object({
    version: z.literal(1),
    nodeId: z.string().uuid(),
    environment: z.literal("production"),
    artifacts: z
      .array(
        z
          .object({
            kind: z.enum([
              "manual-cutover",
              "readmission",
              "source-parity",
              "scheduled-backup",
              "backup-archive-verification",
              "independent-recovery",
              "recovery-schema",
              "current-app-readiness",
            ]),
            mediaType: z.literal("application/json"),
            sha256: digest,
            bytesBase64: z
              .string()
              .min(4)
              .max(262144)
              .regex(
                /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
              ),
          })
          .strict()
      )
      .min(1)
      .max(16),
  })
  .strict()
  .superRefine((bundle, ctx) => {
    if (
      Buffer.byteLength(JSON.stringify(bundle), "utf8") > 256 * 1024 ||
      new Set(bundle.artifacts.map((a) => a.kind)).size !==
        bundle.artifacts.length
    )
      ctx.addIssue({
        code: "custom",
        message:
          "applied evidence bundle exceeds bounded unique artifact custody",
      });
    for (const artifact of bundle.artifacts) {
      const bytes = Buffer.from(artifact.bytesBase64, "base64");
      if (
        bytes.toString("base64") !== artifact.bytesBase64 ||
        createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
      ) {
        ctx.addIssue({
          code: "custom",
          message: "applied evidence bytes differ from their frozen digest",
        });
        continue;
      }
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const value: unknown = JSON.parse(text);
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error();
      } catch {
        ctx.addIssue({
          code: "custom",
          message: "applied evidence requires actual JSON object bytes",
        });
      }
    }
  }) satisfies z.ZodType<
  import("@/types/database-cell").DatabaseCellAppliedEvidenceBundle
>;
