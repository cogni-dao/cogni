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
  readonly action: "contained" | "readmitted";
  readonly incidentId: string;
  readonly actorId: string;
  readonly nodeId: string;
  readonly nodeSlug: string;
  readonly environment: DatabaseEnvironment;
  readonly reason: DatabaseContainmentAction["reason"];
  readonly occurredAt: string;
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
    const roles = rolesFor(input.nodeSlug);
    for (const role of roles) {
      await this.deps.sql.query(`ALTER ROLE ${quoteIdentifier(role)} NOLOGIN`);
    }
    await this.deps.sql.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = ANY($1::text[]) AND pid <> pg_backend_pid()",
      [roles]
    );
    await this.deps.fence.setFenced({
      nodeSlug: input.nodeSlug,
      environment: input.environment,
      fenced: true,
    });
    await this.audit("contained", input);
    return this.status(input);
  }

  async readmit(
    input: DatabaseContainmentAction
  ): Promise<DatabaseContainmentStatus> {
    const roles = rolesFor(input.nodeSlug);
    for (const role of roles) {
      await this.deps.sql.query(`ALTER ROLE ${quoteIdentifier(role)} LOGIN`);
    }
    await this.deps.fence.setFenced({
      nodeSlug: input.nodeSlug,
      environment: input.environment,
      fenced: false,
    });
    await this.audit("readmitted", input);
    return this.status(input);
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
    const rolesCanLogin =
      roleRows.length === roles.length &&
      roleRows.every((role) => role.rolcanlogin);
    const contained = !rolesCanLogin && activeSessions === 0 && firewallFenced;
    const phase = contained
      ? "contained"
      : firewallFenced || !rolesCanLogin || activeSessions > 0
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
    input: DatabaseContainmentAction
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
    });
  }
}

function rolesFor(nodeSlug: string): readonly string[] {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(nodeSlug)) {
    throw new Error("invalid_node_slug");
  }
  const suffix = nodeSlug.replaceAll("-", "_");
  return [`app_${suffix}`, `service_${suffix}`, `readonly_${suffix}`];
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
