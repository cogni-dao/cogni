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

import postgres, { type Sql } from "postgres";
import { z } from "zod";
import type {
  DatabaseRecoveryBeginPort,
  DatabaseRecoveryIncident,
  DatabaseRecoveryProbeObservation,
  DatabaseRecoveryProbePort,
  DatabaseRecoveryVerificationPort,
} from "@/ports";
import {
  DatabaseRecoveryCellAdminBindingSchema,
  type DatabaseRecoveryCellBinding,
  DatabaseRecoveryCellProbeBindingSchema,
  DatabaseRecoveryCellReadmitBindingSchema,
} from "@/shared/secrets/database-cell-binding.data";
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
    ssl: { ca: binding.tlsCaCertificate, rejectUnauthorized: true },
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
    const { dsn: _dsn, tlsCaCertificate: _ca, ...identity } = binding;
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
        const sql = connect(binding);
        try {
          const rows = await sql.unsafe<{ observation: unknown }[]>(
            "SELECT public.database_recovery_probe() AS observation"
          );
          if (rows.length !== 1)
            throw new Error("database_recovery_cell_probe_receipt_missing");
          const observation = DatabaseRecoveryProbeObservationSchema.extend({
            cellSubstrate: DatabaseCellSubstrateSchema,
          }).parse(rows[0]?.observation);
          if (
            observation.database !== binding.databaseName ||
            observation.role !== binding.probeRole ||
            observation.systemIdentifier !== binding.systemIdentifier ||
            !observation.probeRoleIsolated ||
            !observation.runtimeRolesPresent
          )
            throw new Error("database_recovery_cell_probe_identity_mismatch");
          return {
            ...observation,
            cellSubstrate: assertFreshCellSubstrate(
              observation.cellSubstrate,
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
      if (cell)
        throw new Error(
          "database_recovery_dedicated_automatic_containment_disabled"
        );
      return shared.contain(input);
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
