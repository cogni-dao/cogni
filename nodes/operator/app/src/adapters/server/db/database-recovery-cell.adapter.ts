// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/db/database-recovery-cell`
 * Purpose: Route recovery capabilities to their sealed dedicated PostgreSQL ledger.
 * Scope: Assigned TLS endpoints and native recovery functions; does not allocate cells or grant privileges.
 * Invariants: CELL_LOCAL_LEDGER, PINNED_CA, NO_SHARED_TELEMETRY_FALLBACK, FRESH_PROBE_SESSION.
 * Side-effects: IO, time
 * Links: task.5247, shared/secrets/database-cell-binding.data.ts
 * @internal
 */

import { createHash } from "node:crypto";
import postgres, { type Sql } from "postgres";
import { z } from "zod";
import type {
  DatabaseCellBindingReference,
  DatabaseCellPressureObservation,
  DatabaseCellPressurePort,
  DatabaseRecoveryBeginPort,
  DatabaseRecoveryIncident,
  DatabaseRecoveryProbeObservation,
  DatabaseRecoveryProbePort,
  DatabaseRecoveryVerificationPort,
} from "@/ports";
import {
  DATABASE_CELL_NATIVE_CONTROL_FUNCTIONS,
  DatabaseCellLogicalProbeFunctionSchema,
  DatabaseCellNativeControlFunctionObservationSchema,
  DatabaseRecoveryCellAdminBindingSchema,
  type DatabaseRecoveryCellBinding,
  DatabaseRecoveryCellProbeBindingSchema,
  DatabaseRecoveryCellReadmitBindingSchema,
} from "@/shared/secrets/database-cell-binding.data";
import { DatabaseCellNativeControlObservationSchema } from "@/shared/secrets/database-cell-placement.data";
import type {
  DatabaseCellAppliedCustody,
  DatabaseCellAppliedRegistrationFacts,
  DatabaseCellNativeControlObservation,
} from "@/types/database-cell";
import {
  type DatabaseControlSql,
  DatabaseRecoveryProbeObservationSchema,
  PostgresDatabaseRecoveryBeginAdapter,
  PostgresDatabaseRecoveryVerificationAdapter,
  PostgresDatabaseRecoveryWatchdogAdapter,
} from "./database-containment-production.adapter";

const keyFor = (input: { nodeId: string; environment: string }) =>
  `${input.environment}/${input.nodeId}`;

function parseBindings(input: unknown, kind: "probe" | "admin" | "readmit") {
  const schema =
    kind === "probe"
      ? DatabaseRecoveryCellProbeBindingSchema
      : kind === "admin"
        ? DatabaseRecoveryCellAdminBindingSchema
        : DatabaseRecoveryCellReadmitBindingSchema;
  const bindings = z.array(schema).parse(input);
  if (new Set(bindings.map(keyFor)).size !== bindings.length)
    throw new Error("database_recovery_cell_binding_ambiguous");
  return bindings;
}

function connect(binding: DatabaseRecoveryCellBinding): Sql {
  // URI sslmode cannot substitute for the actual pinned CA passed to Node TLS.
  const url = new URL(binding.dsn);
  url.searchParams.delete("sslmode");
  return postgres(url.toString(), {
    max: 1,
    prepare: false,
    ssl: {
      ...(binding.tlsCaCertificate ? { ca: binding.tlsCaCertificate } : {}),
      rejectUnauthorized: true,
    },
    connect_timeout: 5,
    connection: { statement_timeout: 5000, lock_timeout: 2000 },
  });
}

export const DatabaseCellSubstrateSchema = z.object({
  version: z.literal(1),
  scope: z.literal("dedicated-cell"),
  sourceSha: z.string().regex(/^[0-9a-f]{40}$/),
  observedAt: z.string().datetime({ offset: true }),
  ioPressurePct: z.number().finite().min(0).max(100),
  connectionPct: z.number().finite().min(0).max(100),
  memoryHeadroomPct: z.number().finite().min(0).max(100),
  diskHeadroomPct: z.number().finite().min(0).max(100),
});

export function assertFreshCellSubstrate(
  raw: unknown,
  sourceSha: string,
  nowMs = Date.now()
): z.infer<typeof DatabaseCellSubstrateSchema> {
  const snapshot = DatabaseCellSubstrateSchema.parse(raw);
  const age = nowMs - Date.parse(snapshot.observedAt);
  if (snapshot.sourceSha !== sourceSha || age < 0 || age > 5_000)
    throw new Error("database_recovery_cell_substrate_stale_or_foreign");
  return snapshot;
}

export class PostgresDatabaseCellRecoveryProbeAdapter
  implements DatabaseRecoveryProbePort
{
  private readonly bindings: readonly DatabaseRecoveryCellBinding[];
  private readonly pending = new Map<string, Promise<void>>();

  constructor(input: unknown) {
    this.bindings = parseBindings(input, "probe");
  }

  bindingFor(input: Parameters<DatabaseRecoveryProbePort["observe"]>[0]) {
    const binding = this.bindings.find(
      (row) => keyFor(row) === keyFor(input) && row.nodeSlug === input.nodeSlug
    );
    if (!binding) throw new Error("database_recovery_cell_binding_missing");
    const {
      dsn: _dsn,
      tlsCaCertificate: _ca,
      logicalProbeDsn: _logical,
      ...identity
    } = { logicalProbeDsn: undefined, ...binding };
    return identity;
  }

  async observe(
    input: Parameters<DatabaseRecoveryProbePort["observe"]>[0]
  ): Promise<DatabaseRecoveryProbeObservation> {
    this.bindingFor(input);
    const binding = this.bindings.find((row) => keyFor(row) === keyFor(input));
    if (!binding) throw new Error("database_recovery_cell_binding_missing");
    const key = keyFor(binding);
    const operation = (this.pending.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        if (binding.version === 2)
          await qualifyDatabaseCellNativeControl(binding);
        const sql = connect(
          binding.version === 2
            ? { ...binding, dsn: binding.logicalProbeDsn ?? "" }
            : binding
        );
        try {
          const rows = await sql.unsafe<{ observation: unknown }[]>(
            "SELECT public.database_recovery_probe() AS observation"
          );
          if (rows.length !== 1)
            throw new Error("database_recovery_cell_probe_receipt_missing");
          const observation = (
            binding.version === 2
              ? DatabaseRecoveryProbeObservationSchema
              : DatabaseRecoveryProbeObservationSchema.extend({
                  cellSubstrate: DatabaseCellSubstrateSchema,
                })
          ).parse(rows[0]?.observation);
          if (binding.version === 2) {
            const logical = DatabaseCellLogicalProbeFunctionSchema.parse(
              (rows[0]?.observation as { logicalProbeFunction?: unknown })
                ?.logicalProbeFunction
            );
            if (
              logical.definitionSha256 !==
              binding.nativeControl.logicalProbeDefinitionSha256
            )
              throw new Error(
                "database_cell_logical_probe_definition_mismatch"
              );
          }
          if (
            observation.database !== binding.databaseName ||
            observation.role !== binding.probeRole ||
            observation.systemIdentifier !== binding.systemIdentifier ||
            !observation.probeRoleIsolated ||
            !observation.runtimeRolesPresent
          )
            throw new Error("database_recovery_cell_probe_identity_mismatch");
          if (binding.version === 2) return observation;
          return {
            ...observation,
            cellSubstrate: assertFreshCellSubstrate(
              "cellSubstrate" in observation
                ? observation.cellSubstrate
                : undefined,
              binding.sourceSha
            ),
          };
        } finally {
          await sql.end({ timeout: 5 });
        }
      });
    const done = operation.then(
      () => undefined,
      () => undefined
    );
    this.pending.set(key, done);
    try {
      return await operation;
    } finally {
      if (this.pending.get(key) === done) this.pending.delete(key);
    }
  }
}

/** Each SQL executor uses only its own sealed capability and closes on shutdown. */
class CellControlSql implements DatabaseControlSql {
  private readonly sql: Sql;
  constructor(binding: DatabaseRecoveryCellBinding) {
    this.sql = connect(binding);
  }
  query<T extends Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<readonly T[]> {
    return this.sql.unsafe<T[]>(sql, [...params] as never[]);
  }
  close(): Promise<void> {
    return this.sql.end({ timeout: 5 });
  }
}

export function createCellAdminRecoveryControls(input: unknown) {
  return parseBindings(input, "admin").map((binding) => {
    const sql = new CellControlSql(binding);
    return {
      binding,
      sql,
      control: new PostgresDatabaseRecoveryVerificationAdapter(sql),
      watchdog: new PostgresDatabaseRecoveryWatchdogAdapter(sql),
    };
  });
}

export function createCellReadmitRecoveryControls(input: unknown) {
  return parseBindings(input, "readmit").map((binding) => {
    const sql = new CellControlSql(binding);
    return {
      binding,
      sql,
      control: new PostgresDatabaseRecoveryBeginAdapter(sql),
    };
  });
}

function assertIncident(
  incident: DatabaseRecoveryIncident | null,
  binding: DatabaseRecoveryCellBinding
) {
  if (
    incident &&
    (keyFor(incident) !== keyFor(binding) ||
      incident.nodeSlug !== binding.nodeSlug ||
      incident.databaseName !== binding.databaseName ||
      incident.databaseSystemIdentifier !== binding.systemIdentifier ||
      incident.targetBuildSha !== binding.targetBuildSha)
  )
    throw new Error("database_recovery_cell_ledger_identity_mismatch");
  return incident;
}

function assertCellMutationInput(
  input: {
    nodeId: string;
    environment: string;
    targetBuildSha: string;
    databaseSystemIdentifier: string;
    nodeSlug?: string;
  },
  binding: DatabaseRecoveryCellBinding
): void {
  if (
    keyFor(input) !== keyFor(binding) ||
    input.targetBuildSha !== binding.targetBuildSha ||
    input.databaseSystemIdentifier !== binding.systemIdentifier ||
    (input.nodeSlug !== undefined && input.nodeSlug !== binding.nodeSlug)
  )
    throw new Error("database_recovery_cell_mutation_identity_mismatch");
}

type VerificationCell = {
  binding: DatabaseRecoveryCellBinding;
  control: PostgresDatabaseRecoveryVerificationAdapter;
};
type BeginCell = {
  binding: DatabaseRecoveryCellBinding;
  control: PostgresDatabaseRecoveryBeginAdapter;
};

/** Only sealed cell entries select a remote ledger; shared identities retain their existing executor. */
export function routeCellRecoveryVerification(
  shared: PostgresDatabaseRecoveryVerificationAdapter,
  cells: readonly VerificationCell[]
): DatabaseRecoveryVerificationPort &
  Pick<PostgresDatabaseRecoveryVerificationAdapter, "contain"> {
  const route = (input: { nodeId: string; environment: string }) =>
    cells.find((row) => keyFor(row.binding) === keyFor(input));
  return {
    current: async (input) => {
      const cell = route(input);
      return cell
        ? assertIncident(await cell.control.current(input), cell.binding)
        : shared.current(input);
    },
    listPending: async (input) => {
      const [local, ...remote] = await Promise.all([
        shared.listPending(input),
        ...cells
          .filter((row) => row.binding.environment === input.environment)
          .map(async (row) => {
            const incident = assertIncident(
              await row.control.current(row.binding),
              row.binding
            );
            return incident?.state === "recovering" ? [incident] : [];
          }),
      ]);
      return local.filter((row) => !route(row)).concat(...remote);
    },
    contain: async (input) => {
      const cell = route(input);
      if (!cell) return shared.contain(input);
      if (cell.binding.version !== 2)
        throw new Error(
          "database_recovery_dedicated_automatic_containment_disabled"
        );
      assertCellMutationInput(input, cell.binding);
      if (input.databaseName !== cell.binding.databaseName)
        throw new Error("database_recovery_cell_database_mismatch");
      const result = await cell.control.contain(input);
      assertIncident(result, cell.binding);
      return result;
    },
    complete: async (input) => {
      const cell = route(input);
      if (!cell) return shared.complete(input);
      assertCellMutationInput(input, cell.binding);
      assertIncident(await cell.control.current(input), cell.binding);
      const result = await cell.control.complete(input);
      assertIncident(result, cell.binding);
      return result;
    },
    recontain: async (input) => {
      const cell = route(input);
      if (!cell) return shared.recontain(input);
      assertCellMutationInput(input, cell.binding);
      assertIncident(await cell.control.current(input), cell.binding);
      const result = await cell.control.recontain(input);
      assertIncident(result, cell.binding);
      return result;
    },
  };
}

export function routeCellRecoveryBegin(
  shared: PostgresDatabaseRecoveryBeginAdapter,
  cells: readonly BeginCell[]
): DatabaseRecoveryBeginPort {
  const route = (input: { nodeId: string; environment: string }) =>
    cells.find((row) => keyFor(row.binding) === keyFor(input));
  return {
    current: async (input) => {
      const cell = route(input);
      return cell
        ? assertIncident(await cell.control.current(input), cell.binding)
        : shared.current(input);
    },
    listPending: async (input) => {
      const [local, ...remote] = await Promise.all([
        shared.listPending(input),
        ...cells
          .filter((row) => row.binding.environment === input.environment)
          .map(async (row) => {
            const incident = assertIncident(
              await row.control.current(row.binding),
              row.binding
            );
            return incident?.state === "recovering" ? [incident] : [];
          }),
      ]);
      return local.filter((row) => !route(row)).concat(...remote);
    },
    begin: async (input) => {
      const cell = route(input);
      if (!cell) return shared.begin(input);
      assertCellMutationInput(input, cell.binding);
      assertIncident(await cell.control.current(input), cell.binding);
      const result = await cell.control.begin(input);
      assertIncident(result, cell.binding);
      return result;
    },
  };
}

/** Read-only qualification against the complete reviewed function set. Never installs control code. */
export async function qualifyDatabaseCellNativeControl(
  binding: DatabaseRecoveryCellBinding
) {
  if (binding.version !== 2)
    throw new Error("database_cell_native_control_v2_required");
  const sql = connect(binding);
  try {
    const rows = await sql.unsafe<{ observation: unknown }[]>(
      "SELECT public.database_cell_control_qualification($1::uuid,$2::text) AS observation",
      [binding.nodeId, binding.environment]
    );
    const value = z
      .object({
        nodeId: z.string().uuid(),
        nodeSlug: z.string(),
        environment: z.string(),
        controlDatabaseName: z.literal("postgres"),
        databaseName: z.string(),
        systemIdentifier: z.string(),
        allocationReceiptId: z.string().uuid(),
        dseq: z.string(),
        providerAccount: z.string(),
        reviewedSourceSha: z.string(),
        migrationManifestSha256: z.string(),
        installedAt: z.string(),
        observedAt: z.string().datetime({ offset: true }),
        requiredFunctions: z
          .array(DatabaseCellNativeControlFunctionObservationSchema)
          .length(DATABASE_CELL_NATIVE_CONTROL_FUNCTIONS.length),
      })
      .passthrough()
      .parse(rows[0]?.observation);
    for (const field of [
      "nodeId",
      "nodeSlug",
      "environment",
      "databaseName",
      "systemIdentifier",
      "allocationReceiptId",
      "dseq",
      "providerAccount",
    ] as const)
      if (value[field] !== binding[field])
        throw new Error("database_cell_native_control_identity_mismatch");
    const control = binding.nativeControl;
    if (
      value.reviewedSourceSha !== control.reviewedSourceSha ||
      value.migrationManifestSha256 !== control.migrationManifestSha256 ||
      Date.parse(value.installedAt) !== Date.parse(control.installedAt) ||
      Date.now() - Date.parse(value.observedAt) < 0 ||
      Date.now() - Date.parse(value.observedAt) > 5000 ||
      new Set(value.requiredFunctions.map((fn) => fn.signature)).size !==
        DATABASE_CELL_NATIVE_CONTROL_FUNCTIONS.length ||
      value.requiredFunctions.some(
        (fn) =>
          !control.functions.some(
            (expected) =>
              expected.signature === fn.signature &&
              expected.definitionSha256 === fn.definitionSha256
          )
      )
    )
      throw new Error(
        "database_cell_native_control_definition_or_freshness_mismatch"
      );
    return value;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const pressureSchema = z.object({
  nodeId: z.string().uuid(),
  nodeSlug: z.string(),
  environment: z.enum(["candidate-a", "preview", "production"]),
  allocationReceiptId: z.string().uuid(),
  dseq: z.string(),
  providerAccount: z.string(),
  databaseName: z.string(),
  systemIdentifier: z.string(),
  targetBuildSha: z.string().regex(/^[0-9a-f]{40}$/),
  observedAt: z.string().datetime({ offset: true }),
  totalBackends: z.number().int().nonnegative(),
  queryRef: z.string(),
  roles: z.array(
    z.object({
      name: z.string(),
      kind: z.enum(["app", "service", "replay"]),
      connectionLimit: z.number().int().positive(),
      connections: z.number().int().nonnegative(),
      active: z.number().int().nonnegative(),
      waiting: z.number().int().nonnegative(),
      idle: z.number().int().nonnegative(),
      idleInTransaction: z.number().int().nonnegative(),
    })
  ),
});
/** Reuses only the existing private containment capability; no additional secret reader. */
export class PostgresDatabaseCellPressureAdapter
  implements DatabaseCellPressurePort
{
  constructor(
    private readonly cells: readonly {
      binding: DatabaseRecoveryCellBinding;
      sql: DatabaseControlSql;
    }[]
  ) {}
  async observe(
    input: Parameters<DatabaseCellPressurePort["observe"]>[0]
  ): Promise<DatabaseCellPressureObservation> {
    const cell = this.cells.find(
      (row) =>
        keyFor(row.binding) === keyFor(input) &&
        row.binding.nodeSlug === input.nodeSlug &&
        row.binding.substrateHost === input.cellId
    );
    if (!cell || cell.binding.version !== 2)
      throw new Error("database_cell_pressure_qualified_binding_missing");
    const rows = await cell.sql.query<{ observation: unknown }>(
      "SELECT public.database_cell_pressure($1::uuid,$2::text) AS observation",
      [input.nodeId, input.environment]
    );
    const value = pressureSchema.parse(rows[0]?.observation);
    for (const field of [
      "nodeId",
      "nodeSlug",
      "environment",
      "allocationReceiptId",
      "dseq",
      "providerAccount",
      "databaseName",
      "systemIdentifier",
      "targetBuildSha",
    ] as const)
      if (value[field] !== cell.binding[field])
        throw new Error("database_cell_pressure_native_identity_mismatch");
    const age = Date.now() - Date.parse(value.observedAt);
    if (age < 0 || age > 5000) throw new Error("database_cell_pressure_stale");
    return value;
  }
}

/** Composes actual existing observer measurements; performs no role/session mutation. */
export async function observeDatabaseCellNativeControl(input: {
  readonly custody: DatabaseCellAppliedCustody;
  readonly reference: DatabaseCellBindingReference;
  readonly native: DatabaseCellAppliedRegistrationFacts["native"];
  readonly provider: DatabaseCellAppliedRegistrationFacts["provider"];
  readonly packet: DatabaseCellAppliedRegistrationFacts["manualCutover"];
}): Promise<DatabaseCellNativeControlObservation> {
  const { custody, native, provider, packet, reference } = input;
  if (
    !custody.nativeControl ||
    !custody.readOnlyProbe ||
    reference.nodeId !== custody.nodeId ||
    reference.allocationEnvironment !== custody.environment ||
    packet.nodeId !== custody.nodeId ||
    native.systemIdentifier !==
      custody.nativeControl.provenance.systemIdentifier
  )
    throw new Error("database_cell_native_control_custody_or_identity_missing");
  const url = new URL(custody.nativeControl.probe.dsn);
  const binding = DatabaseRecoveryCellProbeBindingSchema.parse({
    scope: "dedicated-cell",
    version: 2,
    nodeId: custody.nodeId,
    nodeSlug: custody.nodeSlug,
    environment: custody.environment,
    databaseName: custody.databaseName,
    probeRole: decodeURIComponent(url.username),
    systemIdentifier: native.systemIdentifier,
    substrateHost: `akash:${provider.providerAccount}:${provider.dseq}`,
    targetBuildSha: custody.targetBuildSha,
    endpoint: { host: url.hostname, port: Number(url.port) },
    allocationReceiptId: packet.allocationReceiptId,
    dseq: provider.dseq,
    providerAccount: provider.providerAccount,
    controlDatabaseName: "postgres",
    nativeControl: custody.nativeControl.provenance,
    tlsTrustKind: custody.tls.kind,
    ...(custody.tls.kind === "private-ca"
      ? { tlsCaCertificate: custody.tls.caCertificate }
      : {}),
    dsn: custody.nativeControl.probe.dsn,
    logicalProbeDsn: custody.readOnlyProbe.dsn,
    logicalProbeCustody: {
      ...custody.readOnlyProbe.custodyRef,
      dsnSha256: createHash("sha256")
        .update(custody.readOnlyProbe.dsn)
        .digest("hex"),
    },
    logicalProbeFunction: {
      signature: "public.database_recovery_probe()",
      definitionSha256:
        custody.nativeControl.provenance.logicalProbeDefinitionSha256,
      owner: "postgres",
      securityDefiner: true,
      publicCanExecute: false,
      probeCanExecute: true,
      searchPath: "pg_catalog, pg_temp",
    },
  });
  const qualified = await qualifyDatabaseCellNativeControl(binding);
  const sql = connect({ ...binding, dsn: custody.readOnlyProbe.dsn });
  try {
    const rows = await sql.unsafe<{ observation: unknown }[]>(
      "SELECT public.database_recovery_probe() AS observation"
    );
    const logical = DatabaseRecoveryProbeObservationSchema.extend({
      logicalProbeFunction: DatabaseCellLogicalProbeFunctionSchema,
    }).parse(rows[0]?.observation);
    if (
      logical.database !== custody.databaseName ||
      logical.role !== decodeURIComponent(url.username) ||
      logical.systemIdentifier !== native.systemIdentifier ||
      !logical.probeRoleIsolated ||
      logical.logicalProbeFunction.definitionSha256 !==
        custody.nativeControl.provenance.logicalProbeDefinitionSha256
    )
      throw new Error("database_cell_native_control_logical_probe_mismatch");
    return DatabaseCellNativeControlObservationSchema.parse({
      ...qualified,
      logicalProbeFunction: logical.logicalProbeFunction,
      exactRoleBounds: native.runtimeRoles.map(
        ({ canLogin: _canLogin, roleReadOnly: _readOnly, ...bounds }) => bounds
      ),
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
