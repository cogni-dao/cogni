// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import type {
  DatabaseContainmentAction,
  DatabaseContainmentPort,
  DatabaseContainmentStatus,
  DatabaseEnvironment,
  DatabaseStateCellPort,
  DatabaseTier,
} from "@/ports";

export interface DatabaseControlSql {
  query<T extends Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[]
  ): Promise<readonly T[]>;
}

export interface DatabaseSourceFence {
  isFenced(input: {
    readonly nodeSlug: string;
    readonly environment: DatabaseEnvironment;
  }): Promise<boolean>;
  setFenced(input: {
    readonly nodeSlug: string;
    readonly environment: DatabaseEnvironment;
    readonly fenced: boolean;
  }): Promise<void>;
}

export interface DatabaseContainmentAuditEvent {
  readonly action:
    | "containment_requested"
    | "contained"
    | "containment_failed"
    | "readmission_requested"
    | "readmitted"
    | "readmission_failed";
  readonly incidentId: string;
  readonly actorId: string;
  readonly nodeId: string;
  readonly nodeSlug: string;
  readonly environment: DatabaseEnvironment;
  readonly reason: DatabaseContainmentAction["reason"];
  readonly occurredAt: string;
  readonly errorCode?: string;
}

export interface PostgresDatabaseContainmentDeps {
  readonly sql: DatabaseControlSql;
  readonly fence: DatabaseSourceFence;
  readonly audit: {
    append(event: DatabaseContainmentAuditEvent): Promise<void>;
    latest(input: {
      readonly nodeId: string;
      readonly environment: DatabaseEnvironment;
    }): Promise<DatabaseContainmentAuditEvent | null>;
  };
  readonly cells?: DatabaseStateCellPort;
  readonly now?: () => Date;
}

export class DatabaseContainmentConfigurationError extends Error {
  readonly code = "DATABASE_CONTAINMENT_CONFIGURATION_INVALID";

  constructor(readonly missingCapabilities: readonly string[]) {
    super(
      `database containment requires privileged capabilities: ${missingCapabilities.join(", ")}`
    );
    this.name = "DatabaseContainmentConfigurationError";
  }
}

/**
 * Production construction boundary. The public app must not synthesize these
 * capabilities: its composition root may wire this only when an admin SQL
 * executor, durable audit sink, and real source-firewall actuator are present.
 */
export function createPostgresDatabaseContainmentAdapter(
  deps: PostgresDatabaseContainmentDeps
): DatabaseContainmentPort {
  const missing: string[] = [];
  if (typeof deps.sql?.query !== "function") missing.push("admin_sql_executor");
  if (
    typeof deps.audit?.append !== "function" ||
    typeof deps.audit?.latest !== "function"
  ) {
    missing.push("durable_audit_sink");
  }
  if (
    typeof deps.fence?.isFenced !== "function" ||
    typeof deps.fence?.setFenced !== "function"
  ) {
    missing.push("source_firewall_actuator");
  }
  if (missing.length > 0) {
    throw new DatabaseContainmentConfigurationError(missing);
  }
  return new PostgresDatabaseContainmentAdapter(deps);
}

/**
 * Audited v1 containment action: revoke node logins, terminate its sessions,
 * and apply its source-specific network fence. No global database restart.
 */
export class PostgresDatabaseContainmentAdapter
  implements DatabaseContainmentPort
{
  private readonly now: () => Date;

  constructor(private readonly deps: PostgresDatabaseContainmentDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async contain(
    input: DatabaseContainmentAction
  ): Promise<DatabaseContainmentStatus> {
    await this.audit("containment_requested", input);
    try {
      const roles = rolesFor(input.nodeSlug);
      for (const role of roles) {
        await this.deps.sql.query(
          `ALTER ROLE ${quoteIdentifier(role)} NOLOGIN`
        );
      }
      await this.deps.sql.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = ANY($1::text[]) AND pid <> pg_backend_pid()",
        [roles]
      );
      // v1 automation intentionally stops at the proven per-node role boundary.
      // The host firewall remains a separately audited, manual secondary control.
      await this.audit("contained", input);
      return this.status(input);
    } catch (error) {
      await this.audit("containment_failed", input, errorCode(error));
      throw error;
    }
  }

  async readmit(
    input: DatabaseContainmentAction
  ): Promise<DatabaseContainmentStatus> {
    if (input.actorId.startsWith("system:")) {
      throw new Error("database_readmission_requires_human_actor");
    }
    await this.audit("readmission_requested", input);
    try {
      const roles = rolesFor(input.nodeSlug);
      for (const role of roles) {
        await this.deps.sql.query(`ALTER ROLE ${quoteIdentifier(role)} LOGIN`);
      }
      await this.audit("readmitted", input);
      return this.status(input);
    } catch (error) {
      await this.audit("readmission_failed", input, errorCode(error));
      throw error;
    }
  }

  async status(input: {
    readonly nodeId: string;
    readonly nodeSlug: string;
    readonly environment: DatabaseEnvironment;
    readonly desiredTier: DatabaseTier;
    readonly budgetProfile: string;
    readonly cellId?: string;
  }): Promise<DatabaseContainmentStatus> {
    const roles = rolesFor(input.nodeSlug);
    const [roleRows, sessionRows, firewallFenced, cell, latest] =
      await Promise.all([
        this.deps.sql.query<{ rolname: string; rolcanlogin: boolean }>(
          "SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname = ANY($1::text[])",
          [roles]
        ),
        this.deps.sql.query<{ count: string | number }>(
          "SELECT count(*) AS count FROM pg_stat_activity WHERE usename = ANY($1::text[])",
          [roles]
        ),
        this.deps.fence.isFenced({
          nodeSlug: input.nodeSlug,
          environment: input.environment,
        }),
        input.cellId && this.deps.cells
          ? this.deps.cells.status({ cellId: input.cellId })
          : Promise.resolve(null),
        this.deps.audit.latest({
          nodeId: input.nodeId,
          environment: input.environment,
        }),
      ]);
    const activeSessions = Number(sessionRows[0]?.count ?? 0);
    // Missing roles fail closed: absence is not evidence that access is enabled.
    const rolesPresent = roleRows.length === roles.length;
    const rolesCanLogin =
      rolesPresent && roleRows.every((role) => role.rolcanlogin);
    const contained = rolesPresent && !rolesCanLogin && activeSessions === 0;
    const phase = contained
      ? "contained"
      : !rolesPresent || !rolesCanLogin || activeSessions > 0
        ? "recovering"
        : "open";
    return {
      nodeId: input.nodeId,
      nodeSlug: input.nodeSlug,
      environment: input.environment,
      desiredTier: input.desiredTier,
      budgetProfile: input.budgetProfile,
      contained,
      phase,
      activeSessions,
      rolesPresent,
      rolesCanLogin,
      firewallFenced,
      cell,
      observedAt: this.now().toISOString(),
      lastTransitionAt: latest?.occurredAt ?? null,
      incidentId: latest?.incidentId ?? null,
      reason: latest?.reason ?? null,
    };
  }

  private async audit(
    action: DatabaseContainmentAuditEvent["action"],
    input: DatabaseContainmentAction,
    error?: string
  ): Promise<void> {
    await this.deps.audit.append({
      action,
      incidentId: input.incidentId,
      actorId: input.actorId,
      nodeId: input.nodeId,
      nodeSlug: input.nodeSlug,
      environment: input.environment,
      reason: input.reason,
      occurredAt: this.now().toISOString(),
      ...(error ? { errorCode: error } : {}),
    });
  }
}

function errorCode(error: unknown): string {
  if (error instanceof Error && /^[a-z0-9_:-]{1,80}$/i.test(error.message)) {
    return error.message;
  }
  return "database_containment_operation_failed";
}

function rolesFor(nodeSlug: string): readonly string[] {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(nodeSlug)) {
    throw new Error("invalid_node_slug");
  }
  const suffix = nodeSlug.replaceAll("-", "_");
  // The as-built per-node roles are app + service. `app_readonly` remains an
  // environment-shared v0 support role, so revoking it would contain every node.
  return [`app_${suffix}`, `service_${suffix}`];
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
