// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/secrets/database-cell-placement.data`
 * Purpose: Bind genuine native incidents or audited manual registrations to truthful physical allocation receipts.
 * Scope: Pure schemas and types; does not allocate resources or authorize cutover.
 * Invariants: Physical allocation environment and operator source remain separate from logical environment and app build.
 * Side-effects: none
 * Links: shared/secrets/database-cell-binding.data.ts, shared/db/akash-tx-allocations.ts
 * @internal
 */
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import { parseMigrationReceipt } from "@/shared/migrations/migration-receipt";
import type { DatabaseCellAppliedRegistrationFacts } from "@/types/database-cell";

import {
  DATABASE_CELL_NATIVE_CONTROL_FUNCTIONS,
  DatabaseCellBindingSchema,
  DatabaseCellLogicalProbeFunctionSchema,
  DatabaseCellManualProvenanceSchema,
  DatabaseCellNativeControlFunctionObservationSchema,
  DatabaseCellRoleBoundsSchema,
  DatabaseCellRuntimePoolLimitsSchema,
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

export const DatabaseCellPhysicalRecoveryProvenanceSchema = z
  .object({
    kind: z.literal("same-cluster-physical-copy"),
    sourceCogniKey: z.string().min(1).max(512),
    sourceReceiptId: z.string().uuid(),
    sourceDseq: z.string().regex(/^[0-9]+$/),
    evidenceSha256: z.string().regex(/^[0-9a-f]{64}$/),
    copyManifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
    originalAppliedSdlHashes: z
      .object({
        source: z.string().regex(/^[0-9a-f]{64}$/),
        target: z.string().regex(/^[0-9a-f]{64}$/),
        app: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
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
        physicalRecovery:
          DatabaseCellPhysicalRecoveryProvenanceSchema.optional(),
        executionActor,
        approvalAuthority,
        readmissionReceiptId: z.string().min(1).max(256),
        manualCutoverPacketSha256: z.string().regex(/^[0-9a-f]{64}$/),
        sourceSystemIdentifier: z.string().regex(/^[0-9]+$/),
        schemaEvolutionReceiptSha256: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional(),
        scheduledBackupReceiptSha256: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional(),
        independentRecoveryReceiptSha256: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional(),
        preservedBackupReceiptSha256: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional(),
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
        runtimePoolLimits: DatabaseCellRuntimePoolLimitsSchema.optional(),
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
          !receipt.binding.manualProvenance ||
          receipt.binding.sourceSha !== undefined ||
          !["applied", "superseded"].includes(receipt.binding.phase) ||
          (receipt.registration.physicalRecovery
            ? receipt.registration.sourceSystemIdentifier !==
                receipt.binding.systemIdentifier ||
              receipt.registration.physicalRecovery.sourceReceiptId ===
                receipt.binding.receiptId ||
              receipt.registration.physicalRecovery.sourceDseq ===
                receipt.binding.dseq ||
              !receipt.registration.preservedBackupReceiptSha256 ||
              receipt.registration.scheduledBackupReceiptSha256 !== undefined ||
              receipt.registration.independentRecoveryReceiptSha256 !==
                undefined
            : receipt.registration.sourceSystemIdentifier ===
                receipt.binding.systemIdentifier ||
              !receipt.registration.scheduledBackupReceiptSha256 ||
              !receipt.registration.independentRecoveryReceiptSha256 ||
              receipt.registration.preservedBackupReceiptSha256 !==
                undefined) ||
          receipt.registration.manualCutoverPacketSha256 !==
            receipt.binding.cutover?.packetSha256
        : !receipt.initialIncidentId ||
          !receipt.binding.sourceSha ||
          receipt.binding.manualProvenance !== undefined ||
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
const manifestVersion = z.string().regex(/^[A-Za-z0-9+/]{43}=$/);
const imageDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const ipAddress = z.string().refine((value) => Boolean(isIP(value)));
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

const snapshotTimeBasis = z.enum([
  "service-start-conservative",
  "dump-command-start-conservative",
  "exact-exported-snapshot",
]);

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
    nextRunAt: timestamp.nullable(),
    serviceActiveState: z.enum([
      "active",
      "inactive",
      "failed",
      "activating",
      "deactivating",
      "unknown",
    ]),
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
        snapshotTimeBasis,
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
export const DatabaseCellNativeControlObservationSchema = z
  .object({
    version: z.literal(1),
    nodeId: z.string().uuid(),
    nodeSlug: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    environment: z.literal("production"),
    controlDatabaseName: z.literal("postgres"),
    databaseName: z.string().regex(/^cogni_[a-z0-9_]+$/),
    systemIdentifier,
    allocationReceiptId: z.string().uuid(),
    dseq: systemIdentifier,
    providerAccount: z.string().regex(/^akash1[0-9a-z]{38}$/),
    reviewedSourceSha: sourceSha,
    migrationManifestSha256: digest,
    installedAt: timestamp,
    observedAt: timestamp,
    admission: z
      .object({
        manualPacketSha256: digest,
        readmissionReceiptSha256: digest,
        admittedAt: timestamp,
        importedAt: timestamp,
        executionActor,
        approvalAuthority,
      })
      .strict(),
    requiredFunctions: z
      .array(DatabaseCellNativeControlFunctionObservationSchema)
      .length(DATABASE_CELL_NATIVE_CONTROL_FUNCTIONS.length),
    logicalProbeFunction: DatabaseCellLogicalProbeFunctionSchema,
    exactRoleBounds: z.array(DatabaseCellRoleBoundsSchema).length(2),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.requiredFunctions.map((fn) => fn.signature)).size !==
        DATABASE_CELL_NATIVE_CONTROL_FUNCTIONS.length ||
      Date.parse(value.observedAt) < Date.parse(value.installedAt) ||
      Date.parse(value.admission.importedAt) <
        Date.parse(value.admission.admittedAt) ||
      Date.parse(value.observedAt) < Date.parse(value.admission.importedAt)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "native control qualification requires complete actual functions and chronological admission import",
      });
  });

export const DatabaseCellAppliedRegistrationFactsSchema = z
  .object({
    observedAt: timestamp,
    nativeControl: DatabaseCellNativeControlObservationSchema.optional(),
    schemaEvolution: z
      .object({
        receiptSha256: digest,
        nodeId: z.string().uuid(),
        environment: z.literal("production"),
        systemIdentifier,
        targetAppSha: sourceSha,
        fromMigrationCount: z.number().int().nonnegative(),
        toMigrationCount: z.number().int().positive(),
        migrationSqlSha256: digest,
        currentJournalSha256: digest,
        completedAt: timestamp,
        observedAt: timestamp,
      })
      .strict()
      .optional(),
    backupRuntime: DatabaseCellBackupRuntimeObservationSchema,
    provider: z
      .object({
        observedAt: timestamp,
        dseq: systemIdentifier,
        providerAccount: z.string().regex(/^akash1[0-9a-z]{38}$/),
        appliedSdlHash: digest,
        postgresImageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
        manifestVersion,
        service: z
          .object({
            name: z.string().min(1).max(63),
            observedGeneration: z.number().int().positive(),
            replicas: z.number().int().nonnegative(),
            updatedReplicas: z.number().int().nonnegative(),
            readyReplicas: z.number().int().nonnegative(),
            availableReplicas: z.number().int().nonnegative(),
            total: z.number().int().nonnegative(),
            available: z.number().int().nonnegative(),
          })
          .strict(),
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
        migrationJournal: z
          .object({
            rowCount: z.number().int().nonnegative().max(1024),
            sha256: digest,
            observedAt: timestamp,
          })
          .strict()
          .optional(),
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
        runtimePoolLimits: DatabaseCellRuntimePoolLimitsSchema.optional(),
        providerManifest: z
          .object({
            observedAt: timestamp,
            services: z
              .array(
                z
                  .object({
                    name: z.string().min(1).max(63),
                    observedGeneration: z.number().int().positive(),
                    replicas: z.number().int().nonnegative(),
                    updatedReplicas: z.number().int().nonnegative(),
                    readyReplicas: z.number().int().nonnegative(),
                    availableReplicas: z.number().int().nonnegative(),
                    total: z.number().int().nonnegative(),
                    available: z.number().int().nonnegative(),
                  })
                  .strict()
              )
              .min(1)
              .max(32),
            consoleVersion: manifestVersion,
            chainVersion: manifestVersion,
            imageDigest,
          })
          .strict(),
        runtimeAdoption: z
          .object({
            observedAt: timestamp,
            systemIdentifier,
            publicBootEgressIp: ipAddress,
            sessions: z
              .array(
                z
                  .object({
                    role: z.string().min(1).max(63),
                    applicationName: z.string().min(1).max(63),
                    peerAddress: ipAddress,
                    count: z.number().int().positive(),
                  })
                  .strict()
              )
              .min(1)
              .max(128),
          })
          .strict(),
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
        manualProvenance: DatabaseCellManualProvenanceSchema,
        appAllocationReceiptId: z.string().uuid(),
        primaryManifestVersion: manifestVersion,
        primaryServiceName: z.string().min(1).max(63),
        appCogniKey: z.string().min(1).max(512),
        appDseq: systemIdentifier,
        appDsnSha256: digest,
        serviceDsnSha256: digest,
        migrationConsumer: z.enum([
          "app-database-url",
          "dedicated-migration-url",
        ]),
        appSdlHash: digest,
        appManifestVersion: manifestVersion,
        appImageDigest: imageDigest,
        appEgressIp: ipAddress,
        appServiceName: z.string().min(1).max(63),
        runtimePoolLimits: DatabaseCellRuntimePoolLimitsSchema.optional(),
        expectedRuntimeApplications: z
          .array(
            z
              .object({
                role: z.string().min(1).max(63),
                applicationName: z.string().min(1).max(63),
              })
              .strict()
          )
          .min(1)
          .max(16),
        expectedRelations: relations,
        preservedRoleBounds: z.array(DatabaseCellRoleBoundsSchema).length(2),
        allocationReceiptId: z.string().uuid(),
        systemIdentifier,
        appSourceSha: sourceSha,
        sourceSystemIdentifier: systemIdentifier,
        schemaEvolution: z
          .object({ receiptSha256: digest })
          .strict()
          .optional(),
        physicalRecovery:
          DatabaseCellPhysicalRecoveryProvenanceSchema.optional(),
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
        snapshotTimeBasis,
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
              "physical-current",
              "physical-recovery",
              "manual-cutover",
              "readmission",
              "source-parity",
              "scheduled-backup",
              "backup-archive-verification",
              "independent-recovery",
              "recovery-schema",
              "current-app-readiness",
              "backup-runtime",
              "recovery-database-metadata",
              "recovery-data-parity",
              "native-control-qualification",
              "schema-evolution",
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

const evolutionFingerprint = z.object({
  copyHeader: z.string().min(1),
  rows: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256Sum: digest,
  sha256Xor: digest,
});

/** Separate actual post-restore migration evidence; never rewrites frozen original parity. */
export function qualifyAppliedSchemaEvolution(input: unknown) {
  const value = z
    .object({
      version: z.literal(1),
      event: z.literal("poly_schema_evolution_applied"),
      nodeId: z.string().uuid(),
      environment: z.literal("production"),
      systemIdentifier,
      database: z.string(),
      targetAppSha: z.string().regex(/^[0-9a-f]{40}$/),
      fromMigrationCount: z.number().int().nonnegative().max(1023),
      toMigrationCount: z.number().int().positive().max(1024),
      startedAt: timestamp,
      completedAt: timestamp,
      migration: z.object({
        tag: z.string().regex(/^[0-9]+_[a-z0-9_]+$/),
        index: z.number().int().nonnegative(),
        when: z.number().int().positive(),
        sqlSha256: digest,
      }),
      newColumns: z
        .array(
          z.object({
            name: z.string().regex(/^[a-z_][a-z0-9_]*$/),
            type: z.string().min(1),
            notNull: z.boolean(),
            default: z.string().nullable(),
          })
        )
        .min(1)
        .max(16),
      oldDefinitionSha256Before: digest,
      oldDefinitionSha256After: digest,
      preservedData: z.object({
        relation: z.literal("public.execution_requests"),
        columns: z
          .array(z.string().regex(/^[a-z_][a-z0-9_]*$/))
          .min(1)
          .max(64),
        before: evolutionFingerprint,
        after: evolutionFingerprint,
      }),
      preservedJournal: z.object({
        rowCount: z.number().int().nonnegative(),
        method: z.literal("canonical-json-id-hash-created_at.v1"),
        beforeSha256: digest,
        afterSha256: digest,
      }),
      currentJournal: z.object({
        rowCount: z.number().int().positive(),
        method: z.literal("canonical-json-id-hash-created_at.v1"),
        sha256: digest,
      }),
      canonicalMigrator: z.object({
        lockKey: z.literal("0x436f676e6901"),
        exitCode: z.literal(0),
        receipt: z.object({
          bytesBase64: z.string().min(1).max(192000),
          sha256: digest,
        }),
      }),
    })
    .parse(input);
  const bytes = Buffer.from(
    value.canonicalMigrator.receipt.bytesBase64,
    "base64"
  );
  const marker = bytes.toString("utf8");
  const receipt = parseMigrationReceipt(marker);
  const latest = receipt?.applied.find(
    (row) => row.tag === value.migration.tag
  );
  if (
    bytes.toString("base64") !== value.canonicalMigrator.receipt.bytesBase64 ||
    createHash("sha256").update(bytes).digest("hex") !==
      value.canonicalMigrator.receipt.sha256 ||
    !receipt ||
    receipt.node !== "poly" ||
    receipt.declared.length !== value.toMigrationCount ||
    receipt.applied.length !== value.toMigrationCount ||
    new Set(receipt.declared).size !== receipt.declared.length ||
    receipt.declared.at(-1) !== value.migration.tag ||
    latest?.hash !== value.migration.sqlSha256 ||
    latest.appliedAtMs !== value.migration.when ||
    receipt.applied.filter((row) => row.tag === value.migration.tag).length !==
      1 ||
    value.toMigrationCount !== value.fromMigrationCount + 1 ||
    value.migration.index !== value.fromMigrationCount ||
    value.preservedJournal.rowCount !== value.fromMigrationCount ||
    value.currentJournal.rowCount !== value.toMigrationCount ||
    value.oldDefinitionSha256Before !== value.oldDefinitionSha256After ||
    value.preservedJournal.beforeSha256 !==
      value.preservedJournal.afterSha256 ||
    JSON.stringify(value.preservedData.before) !==
      JSON.stringify(value.preservedData.after) ||
    value.preservedData.before.copyHeader !==
      `COPY ${value.preservedData.relation} (${value.preservedData.columns.join(", ")}) FROM stdin;` ||
    new Set(value.preservedData.columns).size !==
      value.preservedData.columns.length ||
    new Set(value.newColumns.map((column) => column.name)).size !==
      value.newColumns.length ||
    value.newColumns.some((column) =>
      value.preservedData.columns.includes(column.name)
    ) ||
    Date.parse(value.startedAt) > Date.parse(value.completedAt)
  )
    throw new Error("applied_schema_evolution_receipt_chain_mismatch");
  return value;
}

/** Exact filesystem observations come from authenticated native custody, never SQL approximations. */
export const DatabaseCellPhysicalRecoveryEvidenceSchema = z
  .object({
    version: z.literal(1),
    observedAt: timestamp,
    source: z
      .object({
        cogniKey: z.string().min(1).max(512),
        receiptId: z.string().uuid(),
        dseq: systemIdentifier,
        providerAccount: z.string().regex(/^akash1[0-9a-z]{38}$/),
        systemIdentifier,
        originalAppliedSdlHash: digest,
        heldSdlHash: digest,
        manifestVersion,
        serviceName: z.string().min(1).max(63),
        observedAt: timestamp,
        postgresAbsent: z.literal(true),
        mount: z
          .object({
            path: z.literal("/var/lib/postgresql/data"),
            device: z.string().min(1),
            majorMinor: z.string().regex(/^\d+:\d+$/),
            readOnly: z.literal(true),
          })
          .strict(),
      })
      .strict(),
    copy: z
      .object({
        startedAt: timestamp,
        completedAt: timestamp,
        bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        files: z.number().int().positive(),
        postgresMajor: z.literal(15),
        uid: z.number().int().nonnegative(),
        gid: z.number().int().nonnegative(),
        sourceManifestSha256: digest,
        targetManifestSha256: digest,
        sourceMetadataSha256: digest,
        targetMetadataSha256: digest,
        allTablespacesCovered: z.literal(true),
        transportDrained: z.literal(true),
        originalStartupSha256: digest,
        targetStartupSha256: digest,
      })
      .strict(),
    target: z
      .object({
        observedAt: timestamp,
        dseq: systemIdentifier,
        providerAccount: z.string().regex(/^akash1[0-9a-z]{38}$/),
        originalAppliedSdlHash: digest,
        preimageSdlHash: digest,
        normalSdlHash: digest,
        manifestVersion,
        volume: z
          .object({
            path: z.literal("/var/lib/postgresql/data"),
            device: z.string().min(1),
            majorMinor: z.string().regex(/^\d+:\d+$/),
            totalBytes: z
              .number()
              .int()
              .positive()
              .max(Number.MAX_SAFE_INTEGER),
            usedBytes: z
              .number()
              .int()
              .nonnegative()
              .max(Number.MAX_SAFE_INTEGER),
            availableBytes: z
              .number()
              .int()
              .nonnegative()
              .max(Number.MAX_SAFE_INTEGER),
            totalInodes: z.number().int().positive(),
            availableInodes: z.number().int().nonnegative(),
          })
          .strict(),
      })
      .strict(),
    app: z
      .object({
        originalAppliedSdlHash: digest,
        preimageSdlHash: digest,
        heldSdlHash: digest,
        manifestVersion,
        observedAt: timestamp,
        businessWritersAbsent: z.literal(true),
      })
      .strict(),
    reconciliation: z
      .object({
        observedAt: timestamp,
        xrUid: z.string().uuid(),
        pausedResourceUids: z.array(z.string().uuid()).min(2).max(32),
        acknowledgedPaused: z.literal(true),
        providerOperationsSettled: z.literal(true),
        custodyVersionsSha256: digest,
        dnsRecordSha256: digest,
        independentCustodianWatching: z.literal(true),
      })
      .strict(),
    preservedBackup: z
      .object({
        receiptSha256: digest,
        archiveSha256: digest,
        bytes: z.number().int().positive(),
      })
      .strict(),
  })
  .strict() satisfies z.ZodType<
  import("@/types/database-cell").DatabaseCellPhysicalRecoveryEvidence
>;
export const DatabaseCellPhysicalRecoveryFactsSchema =
  DatabaseCellAppliedRegistrationFactsSchema.omit({
    effectiveApp: true,
    scheduledBackup: true,
    independentRecovery: true,
    backupRuntime: true,
  })
    .extend({
      physicalRecovery: DatabaseCellPhysicalRecoveryEvidenceSchema,
      effectiveApp:
        DatabaseCellAppliedRegistrationFactsSchema.shape.effectiveApp.omit({
          regions: true,
          readinessReceiptSha256: true,
          runtimeAdoption: true,
        }),
    })
    .strict() satisfies z.ZodType<
    import("@/types/database-cell").DatabaseCellPhysicalRecoveryFacts
  >;
