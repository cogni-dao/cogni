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

import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
/** Reviewed installation contract, never a caller-selected list of safe functions. */
export const DATABASE_CELL_NATIVE_CONTROL_FUNCTIONS = [
  {
    signature: "cogni_control.require_actor(text)",
    securityDefiner: false,
    probeCanExecute: false,
    actuatorCanExecute: false,
    readmitterCanExecute: false,
  },
  {
    signature: "cogni_control.assert_system(text)",
    securityDefiner: false,
    probeCanExecute: false,
    actuatorCanExecute: false,
    readmitterCanExecute: false,
  },
  {
    signature: "cogni_control.lock_current(uuid,text)",
    securityDefiner: false,
    probeCanExecute: false,
    actuatorCanExecute: false,
    readmitterCanExecute: false,
  },
  {
    signature: "cogni_control.receipt(cogni_control.database_recoveries)",
    securityDefiner: false,
    probeCanExecute: false,
    actuatorCanExecute: false,
    readmitterCanExecute: false,
  },
  {
    signature:
      "cogni_control.apply_roles(cogni_control.database_recoveries,boolean)",
    securityDefiner: false,
    probeCanExecute: false,
    actuatorCanExecute: false,
    readmitterCanExecute: false,
  },
  {
    signature:
      "public.contain_database_incident(uuid,text,text,text,text,text,text,text,text)",
    securityDefiner: true,
    probeCanExecute: false,
    actuatorCanExecute: true,
    readmitterCanExecute: false,
  },
  {
    signature:
      "public.begin_database_recovery(uuid,text,text,text,text,text,text)",
    securityDefiner: true,
    probeCanExecute: false,
    actuatorCanExecute: false,
    readmitterCanExecute: true,
  },
  {
    signature: "public.complete_database_recovery(uuid,text,text,text,text)",
    securityDefiner: true,
    probeCanExecute: false,
    actuatorCanExecute: true,
    readmitterCanExecute: false,
  },
  {
    signature: "public.recontain_database_recovery(uuid,text,text,text)",
    securityDefiner: true,
    probeCanExecute: false,
    actuatorCanExecute: true,
    readmitterCanExecute: false,
  },
  {
    signature: "public.list_database_recoveries()",
    securityDefiner: true,
    probeCanExecute: false,
    actuatorCanExecute: true,
    readmitterCanExecute: true,
  },
  {
    signature: "public.database_recovery_watchdog_tick(text,text)",
    securityDefiner: true,
    probeCanExecute: false,
    actuatorCanExecute: true,
    readmitterCanExecute: false,
  },
  {
    signature: "public.database_cell_pressure(uuid,text)",
    securityDefiner: true,
    probeCanExecute: false,
    actuatorCanExecute: true,
    readmitterCanExecute: false,
  },
  {
    signature: "public.database_cell_control_qualification(uuid,text)",
    securityDefiner: true,
    probeCanExecute: true,
    actuatorCanExecute: false,
    readmitterCanExecute: false,
  },
  {
    signature: "public.import_database_cell_admission(jsonb)",
    securityDefiner: false,
    probeCanExecute: false,
    actuatorCanExecute: false,
    readmitterCanExecute: false,
  },
  {
    signature:
      "public.register_database_cell_replay(uuid,text,text,text,integer,text)",
    securityDefiner: false,
    probeCanExecute: false,
    actuatorCanExecute: false,
    readmitterCanExecute: false,
  },
] as const;
const controlSignature = z
  .string()
  .refine(
    (signature) =>
      DATABASE_CELL_NATIVE_CONTROL_FUNCTIONS.some(
        (expected) => expected.signature === signature
      ),
    "function is outside the reviewed native control contract"
  );
const controlFunctionFingerprint = z
  .object({
    signature: controlSignature,
    definitionSha256: sha256,
  })
  .strict();
const controlCustodyReference = z
  .object({
    service: z.string().regex(/^[a-z][a-z0-9-]{0,90}$/),
    key: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
    dsnSha256: sha256,
  })
  .strict();
export const DatabaseCellNativeControlProvenanceSchema = z
  .object({
    version: z.literal(1),
    controlDatabaseName: z.literal("postgres"),
    reviewedSourceSha: z.string().regex(/^[0-9a-f]{40}$/),
    migrationManifestSha256: sha256,
    systemIdentifier: z.string().regex(/^[0-9]+$/),
    installedAt: z.string().datetime({ offset: true }),
    qualifiedAt: z.string().datetime({ offset: true }),
    qualificationReceiptSha256: sha256,
    logicalProbeDefinitionSha256: sha256,
    functions: z
      .array(controlFunctionFingerprint)
      .length(DATABASE_CELL_NATIVE_CONTROL_FUNCTIONS.length),
    custody: z
      .object({
        probe: controlCustodyReference,
        actuator: controlCustodyReference,
        readmitter: controlCustodyReference,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.functions.map((fn) => fn.signature)).size !==
        DATABASE_CELL_NATIVE_CONTROL_FUNCTIONS.length ||
      Date.parse(value.qualifiedAt) < Date.parse(value.installedAt)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "native control requires the complete reviewed function set and actual chronological qualification",
      });
  });
export const DatabaseCellNativeControlFunctionObservationSchema =
  controlFunctionFingerprint
    .extend({
      owner: z.literal("postgres"),
      securityDefiner: z.boolean(),
      publicCanExecute: z.literal(false),
      probeCanExecute: z.boolean(),
      actuatorCanExecute: z.boolean(),
      readmitterCanExecute: z.boolean(),
      searchPath: z.string(),
    })
    .strict()
    .superRefine((value, ctx) => {
      const expected = DATABASE_CELL_NATIVE_CONTROL_FUNCTIONS.find(
        (fn) => fn.signature === value.signature
      );
      if (
        !expected ||
        value.securityDefiner !== expected.securityDefiner ||
        value.probeCanExecute !== expected.probeCanExecute ||
        value.actuatorCanExecute !== expected.actuatorCanExecute ||
        value.readmitterCanExecute !== expected.readmitterCanExecute ||
        value.searchPath.replaceAll(/\s/g, "") !== "pg_catalog,pg_temp"
      )
        ctx.addIssue({
          code: "custom",
          message:
            "native function privileges or search path differ from the reviewed capability split",
        });
    });
export const DatabaseCellLogicalProbeFunctionSchema = z
  .object({
    signature: z.literal("public.database_recovery_probe()"),
    definitionSha256: sha256,
    owner: z.literal("postgres"),
    securityDefiner: z.literal(true),
    publicCanExecute: z.literal(false),
    probeCanExecute: z.literal(true),
    searchPath: z
      .string()
      .refine((value) => value.replaceAll(/\s/g, "") === "pg_catalog,pg_temp"),
  })
  .strict();
export const DatabaseCellManualProvenanceSchema = z
  .object({
    kind: z.literal("manual-observed"),
    postgresImageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    managedSdlSha256: sha256,
    qualificationArtifactSha256: sha256,
    qualifiedAt: z.string().datetime({ offset: true }),
    originalProvisionerArtifact: z
      .object({
        sha256,
        executorSourceSha: z
          .string()
          .regex(/^[0-9a-f]{40}$/)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const DatabaseCellBindingBaseSchema = z
  .object({
    version: z.literal(1),
    phase: z.enum(["ready", "applied", "superseded"]),
    supersededBy: z
      .object({ receiptId: z.string().uuid(), packetSha256: sha256 })
      .strict()
      .optional(),
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
    migrationRole: z.string().optional(),
    probeRole: z.string().optional(),
    systemIdentifier: z.string().regex(/^[0-9]+$/),
    failureDomainId: z.string().min(1).max(256),
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
    nativeControl: DatabaseCellNativeControlProvenanceSchema.optional(),
  })
  .strict();
export const DatabaseCellBindingSchema = z
  .union([
    DatabaseCellBindingBaseSchema.extend({
      sourceSha: z.string().regex(/^[0-9a-f]{40}$/),
      manualProvenance: z.never().optional(),
    }).strict(),
    DatabaseCellBindingBaseSchema.extend({
      manualProvenance: DatabaseCellManualProvenanceSchema,
      sourceSha: z.never().optional(),
    }).strict(),
  ])
  .superRefine((binding, ctx) => {
    if (Boolean(binding.supersededBy) !== (binding.phase === "superseded"))
      ctx.addIssue({
        code: "custom",
        message: "superseded history requires exact successor provenance",
      });
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
    if (
      binding.nativeControl &&
      binding.nativeControl.systemIdentifier !== binding.systemIdentifier
    )
      ctx.addIssue({
        code: "custom",
        message:
          "native control provenance belongs to a different physical cell",
      });
    for (const [role, prefix] of [
      [binding.appRole, "app"],
      [binding.serviceRole, "service"],
      [binding.migrationRole, "migration"],
      [binding.probeRole, "probe"],
    ]) {
      if (role !== undefined && role !== `${prefix}_${suffix}`)
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

export type { DatabaseCellBinding } from "@/types/database-cell";

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

export const DatabaseCellRoleBoundsSchema = z
  .object({
    name: z.string().min(1),
    connectionLimit: z.number().int().positive(),
    statementTimeoutMs: z.number().int().nonnegative(),
    lockTimeoutMs: z.number().int().nonnegative(),
    idleInTransactionTimeoutMs: z.number().int().nonnegative(),
    tempFileLimitMiB: z.number().int().min(-1),
    workMemMiB: z.number().positive(),
  })
  .strict();

const custodyReference = z
  .object({
    service: z.string().regex(/^[a-z][a-z0-9-]{0,127}$/),
    key: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
  })
  .strict();
const currentConsumer = z
  .object({ dsn: z.string().min(1), custody: custodyReference })
  .strict();
/** Resolved only from the existing private cell bank; never accepted over HTTP. */
export const DatabaseCellRuntimePoolLimitsSchema = z
  .object({
    replicaCount: z.literal(1),
    app: z.number().int().positive().max(1000),
    service: z.number().int().positive().max(1000),
    read: z.number().int().positive().max(1000),
  })
  .strict();

export const DatabaseCellAppliedCustodySchema = z
  .object({
    version: z.literal(1),
    nodeId: z.string().uuid(),
    nodeSlug: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    environment: z.literal("production"),
    manualProvenance: DatabaseCellManualProvenanceSchema,
    targetBuildSha: z.string().regex(/^[0-9a-f]{40}$/),
    canonicalEndpointHost: z
      .string()
      .max(253)
      .regex(/^[a-z0-9][a-z0-9.-]+$/)
      .refine((host) => !isIP(host)),
    databaseName: z.string().regex(/^cogni_[a-z0-9_]+$/),
    appRole: z.string(),
    serviceRole: z.string(),
    budgetProfile: z.enum([
      "shared-default-v1",
      "dedicated-high-throughput-v1",
    ]),
    runtimePoolLimits: DatabaseCellRuntimePoolLimitsSchema.optional(),
    budget: z
      .object({
        kind: z.literal("preserved-role-bounds"),
        roles: z.array(DatabaseCellRoleBoundsSchema).length(2),
      })
      .strict(),
    tlsCertificate: z.string().startsWith("-----BEGIN CERTIFICATE-----"),
    tls: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("system") }).strict(),
      z
        .object({
          kind: z.literal("private-ca"),
          caCertificate: z.string().startsWith("-----BEGIN CERTIFICATE-----"),
          custody: custodyReference,
        })
        .strict(),
    ]),
    app: currentConsumer,
    service: currentConsumer,
    migration: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("app-database-url") }).strict(),
      z
        .object({
          kind: z.literal("dedicated-migration-url"),
          dsn: z.string().min(1),
          custody: custodyReference,
        })
        .strict(),
    ]),
    readOnlyProbe: z
      .object({ dsn: z.string().min(1), custodyRef: custodyReference })
      .strict()
      .optional(),
    nativeControl: z
      .object({
        provenance: DatabaseCellNativeControlProvenanceSchema,
        probe: z
          .object({ dsn: z.string().min(1), custodyRef: custodyReference })
          .strict(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((custody, ctx) => {
    const base = `cogni_${custody.nodeSlug.replaceAll("-", "_")}`;
    const suffix = custody.databaseName.slice("cogni_".length);
    if (
      new Set(custody.budget.roles.map((role) => role.name)).size !== 2 ||
      ![custody.appRole, custody.serviceRole].every((name) =>
        custody.budget.roles.some((role) => role.name === name)
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "preserved bounds must name exactly the owned runtime roles",
      });
    if (
      ![base, `${base}_production`].includes(custody.databaseName) ||
      custody.appRole !== `app_${suffix}` ||
      custody.serviceRole !== `service_${suffix}`
    )
      ctx.addIssue({
        code: "custom",
        message: "applied custody leaves its canonical node database",
      });
    const pools = custody.runtimePoolLimits;
    if (pools) {
      const appCap =
        custody.budget.roles.find((role) => role.name === custody.appRole)
          ?.connectionLimit ?? 0;
      const serviceCap =
        custody.budget.roles.find((role) => role.name === custody.serviceRole)
          ?.connectionLimit ?? 0;
      // Dedicated leader uses the service role too. Keep one connection spare per role.
      if (
        pools.app * pools.replicaCount >= appCap ||
        (pools.service + pools.read + 1) * pools.replicaCount >= serviceCap
      )
        ctx.addIssue({
          code: "custom",
          message:
            "runtime pools, read pool and leader must preserve per-role connection reserve",
        });
    }
    if (custody.nativeControl) {
      const { provenance, probe } = custody.nativeControl;
      const refs = provenance.custody;
      const expectedRefs = [
        [
          refs.probe,
          `${custody.nodeSlug}-database-recovery-probe`,
          "DATABASE_CELL_CONTROL_PROBE_URL",
        ],
        [
          refs.actuator,
          `${custody.nodeSlug}-database-cell-actuator`,
          "DATABASE_CELL_ACTUATOR_URL",
        ],
        [
          refs.readmitter,
          `${custody.nodeSlug}-database-cell-readmitter`,
          "DATABASE_CELL_READMIT_URL",
        ],
      ] as const;
      if (
        expectedRefs.some(
          ([ref, service, key]) => ref.service !== service || ref.key !== key
        ) ||
        probe.custodyRef.service !== refs.probe.service ||
        probe.custodyRef.key !== refs.probe.key
      )
        ctx.addIssue({
          code: "custom",
          message:
            "native control capability leaves its distinct owned component bank",
        });
      try {
        if (
          createHash("sha256").update(probe.dsn).digest("hex") !==
          refs.probe.dsnSha256
        )
          throw new Error();
        const dsn = new URL(probe.dsn);
        const logicalProbe = custody.readOnlyProbe
          ? new URL(custody.readOnlyProbe.dsn)
          : null;
        if (
          !logicalProbe ||
          dsn.protocol !== "postgresql:" ||
          dsn.hostname !== custody.canonicalEndpointHost ||
          dsn.port !== logicalProbe.port ||
          decodeURIComponent(dsn.username) !== `probe_${suffix}` ||
          dsn.password !== logicalProbe.password ||
          dsn.pathname !== "/postgres" ||
          dsn.searchParams.size !== 1 ||
          dsn.searchParams.get("sslmode") !== "verify-full" ||
          dsn.hash
        )
          throw new Error();
      } catch {
        ctx.addIssue({
          code: "custom",
          message:
            "control probe must reuse the exact isolated logical probe credential on the owned postgres control database",
        });
      }
    }
    const consumers: [{ dsn: string }, string][] = [
      [custody.app, custody.appRole],
      [custody.service, custody.serviceRole],
      ...(custody.readOnlyProbe
        ? [
            [custody.readOnlyProbe, `probe_${suffix}`] as [
              { dsn: string },
              string,
            ],
          ]
        : []),
      ...(custody.migration.kind === "dedicated-migration-url"
        ? [
            [custody.migration, `migration_${suffix}`] as [
              { dsn: string },
              string,
            ],
          ]
        : []),
    ];
    for (const [consumer, role] of consumers) {
      try {
        const dsn = new URL(consumer.dsn);
        if (
          dsn.protocol !== "postgresql:" ||
          dsn.hostname !== custody.canonicalEndpointHost ||
          !dsn.port ||
          !dsn.password ||
          decodeURIComponent(dsn.username) !== role ||
          decodeURIComponent(dsn.pathname.slice(1)) !== custody.databaseName ||
          dsn.searchParams.get("sslmode") !== "verify-full" ||
          dsn.hash ||
          dsn.searchParams.size !== 1
        )
          throw new Error();
      } catch {
        ctx.addIssue({
          code: "custom",
          message:
            "applied consumer DSN differs from canonical strict TLS custody",
        });
      }
    }
    if (
      custody.readOnlyProbe &&
      (custody.readOnlyProbe.custodyRef.service !==
        `${custody.nodeSlug}-database-recovery-probe` ||
        custody.readOnlyProbe.custodyRef.key !== "DATABASE_RECOVERY_PROBE_URL")
    )
      ctx.addIssue({
        code: "custom",
        message:
          "read-only probe reference leaves its actual owned credential bank",
      });
    if (
      custody.app.custody.service !== custody.nodeSlug ||
      custody.app.custody.key !== "DATABASE_URL" ||
      custody.service.custody.service !== custody.nodeSlug ||
      custody.service.custody.key !== "DATABASE_SERVICE_URL" ||
      (custody.migration.kind === "dedicated-migration-url" &&
        (custody.migration.custody.service !==
          `${custody.nodeSlug}-database-migration` ||
          custody.migration.custody.key !== "DATABASE_MIGRATION_URL"))
    )
      ctx.addIssue({
        code: "custom",
        message: "applied consumer references leave their existing owned bank",
      });
  }) satisfies z.ZodType<
  import("@/types/database-cell").DatabaseCellAppliedCustody
>;
export type { DatabaseCellAppliedCustody } from "@/types/database-cell";

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
    backupRole: z.string(),
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
    backupPassword: cellPassword,
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
    canonicalEndpointHost: z
      .string()
      .max(253)
      .regex(/^[a-z0-9][a-z0-9.-]+$/)
      .refine((host) => !isIP(host))
      .optional(),
    logicalDatabases: z.array(DatabaseCellLogicalDatabaseSchema).min(1).max(3),
    diagnostic: z
      .object({
        sourceDatabaseName: z.string(),
        databaseName: z.string(),
        replayRole: z.string(),
        replayPassword: cellPassword,
        targetBuildSha: sourceSha,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((kit, ctx) => {
    if (kit.diagnostic) {
      const production = kit.logicalDatabases.find(
        (lane) => lane.environment === "production"
      );
      if (
        !production ||
        kit.diagnostic.sourceDatabaseName !== production.databaseName ||
        kit.diagnostic.databaseName !==
          `${production.databaseName}_diagnostic` ||
        kit.diagnostic.replayRole !==
          `replay_${kit.diagnostic.databaseName.slice("cogni_".length)}` ||
        kit.diagnostic.targetBuildSha !== production.sourceSha ||
        [
          kit.rootPassword,
          kit.actuatorPassword,
          kit.readmitPassword,
          ...kit.logicalDatabases.flatMap((lane) => [
            lane.appPassword,
            lane.servicePassword,
            lane.migrationPassword,
            lane.probePassword,
            lane.backupPassword,
          ]),
        ].includes(kit.diagnostic.replayPassword)
      )
        ctx.addIssue({
          code: "custom",
          message:
            "diagnostic component differs from its isolated production clone scope",
        });
    }
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
        [lane.backupRole, "backup"],
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

export type { DatabaseCellBootstrapKit } from "@/types/database-cell";

/** Tagged private projection: dedicated endpoints never enter the shared 5432 seal. */
export const DatabaseRecoveryCellCommonSchema = z
  .object({
    scope: z.literal("dedicated-cell"),
    version: z.never().optional(),
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

const manualControlCommon = DatabaseRecoveryCellCommonSchema.omit({
  sourceSha: true,
  tlsCaCertificate: true,
})
  .extend({
    version: z.literal(2),
    sourceSha: z.never().optional(),
    controlDatabaseName: z.literal("postgres"),
    allocationReceiptId: z.string().uuid(),
    dseq: z.string().regex(/^[0-9]+$/),
    providerAccount: z.string().regex(/^akash1[0-9a-z]{38}$/),
    nativeControl: DatabaseCellNativeControlProvenanceSchema,
    tlsTrustKind: z.enum(["system", "private-ca"]),
    tlsCaCertificate: z
      .string()
      .startsWith("-----BEGIN CERTIFICATE-----")
      .optional(),
    logicalProbeDsn: z.string().url().optional(),
    logicalProbeCustody: controlCustodyReference.optional(),
    logicalProbeFunction: DatabaseCellLogicalProbeFunctionSchema.optional(),
  })
  .strict();

function privateRoute(expectedRole: "probe" | "actuator" | "readmitter") {
  return z
    .union([
      DatabaseRecoveryCellCommonSchema.extend({
        dsn: z.string().url(),
      }).strict(),
      manualControlCommon.extend({ dsn: z.string().url() }).strict(),
    ])
    .superRefine((value, ctx) => {
      const manual = "version" in value && value.version === 2;
      const role =
        expectedRole === "probe"
          ? value.probeRole
          : `database_reliability_${expectedRole}`;
      const validDsn = (dsn: string, database: string, expected: string) => {
        const url = new URL(dsn);
        return (
          ["postgres:", "postgresql:"].includes(url.protocol) &&
          decodeURIComponent(url.username) === expected &&
          Boolean(url.password) &&
          url.hostname === value.endpoint.host &&
          url.port === String(value.endpoint.port) &&
          decodeURIComponent(url.pathname.slice(1)) === database &&
          [...url.searchParams.keys()].every((key) => key === "sslmode") &&
          url.searchParams.getAll("sslmode").length === 1 &&
          url.searchParams.get("sslmode") === "verify-full" &&
          !url.hash
        );
      };
      if (
        !validDsn(
          value.dsn,
          manual || expectedRole !== "probe" ? "postgres" : value.databaseName,
          role
        ) ||
        value.probeRole !==
          `probe_${value.databaseName.slice("cogni_".length)}` ||
        ![
          `cogni_${value.nodeSlug.replaceAll("-", "_")}`,
          `cogni_${value.nodeSlug.replaceAll("-", "_")}_${value.environment.replaceAll("-", "_")}`,
        ].includes(value.databaseName)
      ) {
        ctx.addIssue({
          code: "custom",
          message:
            "private cell DSN does not match the applied scoped identity",
        });
      }
      if (!manual) return;
      if (
        value.environment !== "production" ||
        value.nativeControl.systemIdentifier !== value.systemIdentifier ||
        (value.tlsTrustKind === "system"
          ? value.tlsCaCertificate !== undefined
          : value.tlsCaCertificate === undefined)
      )
        ctx.addIssue({
          code: "custom",
          message: "manual control identity or TLS custody differs",
        });
      const ref = value.nativeControl.custody[expectedRole];
      const bank =
        expectedRole === "probe"
          ? `${value.nodeSlug}-database-recovery-probe`
          : `${value.nodeSlug}-database-cell-${expectedRole}`;
      const key =
        expectedRole === "probe"
          ? "DATABASE_CELL_CONTROL_PROBE_URL"
          : expectedRole === "actuator"
            ? "DATABASE_CELL_ACTUATOR_URL"
            : "DATABASE_CELL_READMIT_URL";
      const sha = (dsn: string) =>
        createHash("sha256").update(dsn).digest("hex");
      if (
        ref.service !== bank ||
        ref.key !== key ||
        ref.dsnSha256 !== sha(value.dsn)
      )
        ctx.addIssue({
          code: "custom",
          message: "manual control DSN differs from installed scoped custody",
        });
      if (expectedRole === "probe") {
        if (
          !value.logicalProbeDsn ||
          !value.logicalProbeCustody ||
          !value.logicalProbeFunction ||
          !validDsn(
            value.logicalProbeDsn,
            value.databaseName,
            value.probeRole
          ) ||
          value.logicalProbeCustody.service !==
            `${value.nodeSlug}-database-recovery-probe` ||
          value.logicalProbeCustody.key !== "DATABASE_RECOVERY_PROBE_URL" ||
          value.logicalProbeCustody.dsnSha256 !== sha(value.logicalProbeDsn) ||
          value.logicalProbeFunction.definitionSha256 !==
            value.nativeControl.logicalProbeDefinitionSha256 ||
          new URL(value.logicalProbeDsn).username !==
            new URL(value.dsn).username ||
          new URL(value.logicalProbeDsn).password !==
            new URL(value.dsn).password
        )
          ctx.addIssue({
            code: "custom",
            message:
              "manual logical health capability is missing or differs from qualified custody",
          });
      } else if (
        value.logicalProbeDsn ||
        value.logicalProbeCustody ||
        value.logicalProbeFunction
      )
        ctx.addIssue({
          code: "custom",
          message:
            "mutating workers cannot receive the logical probe credential",
        });
    });
}
export const DatabaseRecoveryCellProbeBindingSchema = privateRoute("probe");
export const DatabaseRecoveryCellAdminBindingSchema = privateRoute("actuator");
export const DatabaseRecoveryCellReadmitBindingSchema =
  privateRoute("readmitter");
export type DatabaseRecoveryCellBinding = z.infer<
  typeof DatabaseRecoveryCellProbeBindingSchema
>;

/** Canonical strict-TLS URL composition; callers keep credentials in private custody. */
export function composeDatabaseCellDsn(
  endpoint: { host: string; port: number },
  database: string,
  role: string,
  password: string
): string {
  const value = new URL(`postgresql://${endpoint.host}:${endpoint.port}`);
  value.username = role;
  value.password = password;
  value.pathname = `/${database}`;
  value.searchParams.set("sslmode", "verify-full");
  return value.href;
}
