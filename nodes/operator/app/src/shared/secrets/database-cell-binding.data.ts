// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/secrets/database-cell-binding.data`
 * Purpose: Validate the allocation-bound identity of a verified dedicated database cell and its approved cutover.
 * Scope: Pure schemas and canonical checks; does not allocate resources, query databases, or publish secrets.
 * Invariants: Assigned TCP endpoint and pinned TLS identity belong to an allocated receipt; readiness alone never authorizes cutover.
 * Side-effects: none
 * Links: docs/spec/secrets-management.md, shared/db/akash-tx-allocations.ts
 * @internal
 */

import { isIP } from "node:net";
import { z } from "zod";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
export const DatabaseCellBindingSchema = z
  .object({
    version: z.literal(1),
    phase: z.enum(["ready", "applied", "superseded"]),
    receiptId: z.string().uuid(),
    cogniKey: z.string().min(1).max(512),
    nodeId: z.string().uuid(),
    nodeSlug: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    environment: z.enum(["candidate-a", "preview", "production"]),
    provider: z.literal("akash"),
    dseq: z.string().regex(/^[0-9]+$/),
    providerAccount: z.string().regex(/^akash1[0-9a-z]{38}$/),
    endpoint: z
      .object({
        host: z
          .string()
          .min(1)
          .max(253)
          .regex(/^[a-zA-Z0-9.:-]+$/),
        port: z.number().int().min(1).max(65535),
        tlsMode: z.enum(["verify-ca", "verify-full"]),
        tlsCertificateSha256: sha256,
      })
      .strict(),
    databaseName: z.string().regex(/^cogni_[a-z0-9_]+$/),
    appRole: z.string(),
    serviceRole: z.string(),
    migrationRole: z.string(),
    probeRole: z.string(),
    systemIdentifier: z.string().regex(/^[0-9]+$/),
    failureDomainId: z.string().min(1).max(256),
    sourceSha: z.string().regex(/^[0-9a-f]{40}$/),
    budgetProfile: z.string().min(1).max(128),
    appliedSdlHash: sha256,
    readyAt: z.string().datetime({ offset: true }),
    cutover: z
      .object({
        packetSha256: sha256,
        actorId: z.string().min(1).max(256),
        approvedAt: z.string().datetime({ offset: true }),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((binding, ctx) => {
    const base = `cogni_${binding.nodeSlug.replaceAll("-", "_")}`;
    if (
      ![base, `${base}_${binding.environment.replaceAll("-", "_")}`].includes(
        binding.databaseName
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "database is outside the canonical node and source-lane namespace",
      });
    }
    const suffix = binding.databaseName.slice("cogni_".length);
    for (const [role, prefix] of [
      [binding.appRole, "app"],
      [binding.serviceRole, "service"],
      [binding.migrationRole, "migration"],
      [binding.probeRole, "probe"],
    ]) {
      if (role !== `${prefix}_${suffix}`)
        ctx.addIssue({
          code: "custom",
          message: "cell role does not match its database",
        });
    }
    if (
      binding.failureDomainId !==
      `akash:${binding.providerAccount}:${binding.dseq}`
    ) {
      ctx.addIssue({
        code: "custom",
        message: "cell failure domain does not match its allocated lease",
      });
    }
    if (binding.phase !== "ready" && !binding.cutover) {
      ctx.addIssue({
        code: "custom",
        message: "applied placement requires explicit cutover approval",
      });
    }
    if (
      binding.phase !== "ready" &&
      (binding.endpoint.tlsMode !== "verify-full" ||
        isIP(binding.endpoint.host))
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "applied cell requires its measured DNS endpoint and strict TLS",
      });
    }
  });

export type DatabaseCellBinding = z.infer<typeof DatabaseCellBindingSchema>;

/** Values come from the declared immutable profile, never a CREATE caller. */
export const DatabaseCellBudgetSchema = z
  .object({
    appConnectionLimit: z.number().int().positive(),
    appStatementTimeoutMs: z.number().int().positive(),
    serviceConnectionLimit: z.number().int().positive(),
    serviceStatementTimeoutMs: z.number().int().positive(),
    lockTimeoutMs: z.number().int().positive(),
    idleInTransactionTimeoutMs: z.number().int().positive(),
    tempFileLimitMiB: z.number().int().positive(),
    workMemMiB: z.number().int().positive(),
  })
  .strict();

const cellPassword = z.string().regex(/^[0-9a-f]{48}$/);
const environment = z.enum(["candidate-a", "preview", "production"]);
const sourceSha = z.string().regex(/^[0-9a-f]{40}$/);
export const DatabaseCellLogicalDatabaseSchema = z
  .object({
    environment,
    databaseName: z.string().regex(/^cogni_[a-z0-9_]+$/),
    appRole: z.string(),
    serviceRole: z.string(),
    migrationRole: z.string(),
    probeRole: z.string(),
    sourceSha,
    budgetProfile: z.enum([
      "shared-default-v1",
      "dedicated-high-throughput-v1",
    ]),
    budget: DatabaseCellBudgetSchema,
    appPassword: cellPassword,
    servicePassword: cellPassword,
    migrationPassword: cellPassword,
    probePassword: cellPassword,
  })
  .strict();

/** Private actuator volume only: no field in this kit is accepted from CREATE. */
export const DatabaseCellBootstrapKitSchema = z
  .object({
    version: z.literal(1),
    nodeId: z.string().uuid(),
    nodeSlug: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    environment,
    sourceSha,
    rootPassword: cellPassword,
    actuatorPassword: cellPassword,
    readmitPassword: cellPassword,
    tlsCaCertificate: z.string().startsWith("-----BEGIN CERTIFICATE-----"),
    tlsCertificate: z.string().startsWith("-----BEGIN CERTIFICATE-----"),
    tlsPrivateKey: z.string().regex(/^-----BEGIN (RSA )?PRIVATE KEY-----/),
    logicalDatabases: z.array(DatabaseCellLogicalDatabaseSchema).min(1).max(3),
  })
  .strict()
  .superRefine((kit, ctx) => {
    const environments = new Set<string>();
    const databases = new Set<string>();
    const base = `cogni_${kit.nodeSlug.replaceAll("-", "_")}`;
    for (const lane of kit.logicalDatabases) {
      if (
        environments.has(lane.environment) ||
        databases.has(lane.databaseName)
      ) {
        ctx.addIssue({
          code: "custom",
          message: "duplicate logical lane/database",
        });
      }
      environments.add(lane.environment);
      databases.add(lane.databaseName);
      if (
        ![base, `${base}_${lane.environment.replaceAll("-", "_")}`].includes(
          lane.databaseName
        )
      ) {
        ctx.addIssue({
          code: "custom",
          message: "logical database leaves its source-lane namespace",
        });
      }
      const suffix = lane.databaseName.slice("cogni_".length);
      for (const [role, prefix] of [
        [lane.appRole, "app"],
        [lane.serviceRole, "service"],
        [lane.migrationRole, "migration"],
        [lane.probeRole, "probe"],
      ]) {
        if (role !== `${prefix}_${suffix}`)
          ctx.addIssue({
            code: "custom",
            message: "logical role/database pair differs",
          });
      }
    }
  });

export const DatabaseCellBootstrapKitsSchema = z
  .array(DatabaseCellBootstrapKitSchema)
  .superRefine((kits, ctx) => {
    const identities = new Set<string>();
    for (const kit of kits) {
      const identity = `${kit.nodeId}/${kit.environment}`;
      if (identities.has(identity))
        ctx.addIssue({
          code: "custom",
          message: "duplicate physical cell kit",
        });
      identities.add(identity);
    }
  });

export type DatabaseCellBootstrapKit = z.infer<
  typeof DatabaseCellBootstrapKitSchema
>;

/** Tagged private projection: dedicated endpoints never enter the shared 5432 seal. */
export const DatabaseRecoveryCellCommonSchema = z
  .object({
    scope: z.literal("dedicated-cell"),
    nodeId: z.string().uuid(),
    nodeSlug: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    environment,
    databaseName: z.string().regex(/^cogni_[a-z0-9_]+$/),
    probeRole: z.string(),
    systemIdentifier: z.string().regex(/^[0-9]+$/),
    substrateHost: z.string().regex(/^akash:akash1[0-9a-z]{38}:[0-9]+$/),
    sourceSha,
    targetBuildSha: sourceSha,
    endpoint: z
      .object({
        host: z
          .string()
          .regex(/^[a-z0-9][a-z0-9.-]+$/)
          .refine(
            (host) => !isIP(host),
            "actual measured DNS endpoint required"
          ),
        port: z.number().int().min(1).max(65535),
      })
      .strict(),
    tlsCaCertificate: z.string().startsWith("-----BEGIN CERTIFICATE-----"),
  })
  .strict();

function privateRoute(expectedRole: "probe" | "actuator" | "readmitter") {
  return DatabaseRecoveryCellCommonSchema.extend({
    dsn: z.string().url(),
  }).superRefine((value, ctx) => {
    const url = new URL(value.dsn);
    const role =
      expectedRole === "probe"
        ? value.probeRole
        : `database_reliability_${expectedRole}`;
    const database = expectedRole === "probe" ? value.databaseName : "postgres";
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      decodeURIComponent(url.username) !== role ||
      !url.password ||
      url.hostname !== value.endpoint.host ||
      url.port !== String(value.endpoint.port) ||
      decodeURIComponent(url.pathname.slice(1)) !== database ||
      [...url.searchParams.keys()].some((key) => key !== "sslmode") ||
      url.searchParams.getAll("sslmode").length !== 1 ||
      url.searchParams.get("sslmode") !== "verify-full" ||
      value.probeRole !==
        `probe_${value.databaseName.slice("cogni_".length)}` ||
      ![
        `cogni_${value.nodeSlug.replaceAll("-", "_")}`,
        `cogni_${value.nodeSlug.replaceAll("-", "_")}_${value.environment.replaceAll("-", "_")}`,
      ].includes(value.databaseName)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "private cell DSN does not match the applied scoped identity",
      });
    }
  });
}
export const DatabaseRecoveryCellProbeBindingSchema = privateRoute("probe");
export const DatabaseRecoveryCellAdminBindingSchema = privateRoute("actuator");
export const DatabaseRecoveryCellReadmitBindingSchema =
  privateRoute("readmitter");
export type DatabaseRecoveryCellBinding = z.infer<
  typeof DatabaseRecoveryCellProbeBindingSchema
>;
