// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { Logger } from "pino";
import postgres, { type Sql } from "postgres";
import type { LokiReaderPort } from "@/ports";
import type {
  DatabaseContainmentAuditEvent,
  DatabaseControlSql,
  DatabaseSourceFence,
} from "./postgres-database-containment.adapter";
import {
  createPostgresDatabaseContainmentAdapter,
  type PostgresDatabaseContainmentDeps,
} from "./postgres-database-containment.adapter";

export interface ProductionDatabaseContainmentConfig {
  readonly adminDsn: string;
  readonly log: Logger;
  readonly loki: LokiReaderPort;
  readonly lokiEnvironment: string;
  readonly cherry: ConstructorParameters<
    typeof CherryDatabaseSourceFenceAdapter
  >[0];
  readonly cells?: PostgresDatabaseContainmentDeps["cells"];
}

/** Complete production composition; every privileged dependency is mandatory. */
export function createProductionDatabaseContainmentAdapter(
  config: ProductionDatabaseContainmentConfig
) {
  if (
    !config.adminDsn ||
    !config.log ||
    !config.loki ||
    !config.lokiEnvironment
  ) {
    throw new Error("database_containment_production_config_invalid");
  }
  return createPostgresDatabaseContainmentAdapter({
    sql: new PostgresAdminSqlAdapter(config.adminDsn),
    audit: new PinoLokiDatabaseContainmentAuditAdapter(
      config.log,
      config.loki,
      config.lokiEnvironment
    ),
    fence: new CherryDatabaseSourceFenceAdapter(config.cherry),
    ...(config.cells ? { cells: config.cells } : {}),
  });
}

/** Privileged SQL executor. The injected DSN remains closure-private. */
export class PostgresAdminSqlAdapter implements DatabaseControlSql {
  private readonly client: Sql;

  constructor(adminDsn: string) {
    const url = new URL(adminDsn);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) {
      throw new Error("database_control_dsn_invalid");
    }
    this.client = postgres(adminDsn, { max: 1, prepare: false });
  }

  async query<T extends Record<string, unknown>>(
    statement: string,
    params: readonly unknown[] = []
  ): Promise<readonly T[]> {
    return this.client.unsafe<T[]>(statement, [...params] as never[]);
  }
}

/** Pino is the durable write path (stdout -> Alloy -> Loki); Loki is readback. */
export class PinoLokiDatabaseContainmentAuditAdapter {
  constructor(
    private readonly log: Logger,
    private readonly loki: LokiReaderPort,
    private readonly lokiEnvironment: string
  ) {}

  async append(event: DatabaseContainmentAuditEvent): Promise<void> {
    this.log.info(
      { event: "database_containment_transition", ...event },
      "database_containment_transition"
    );
  }

  async latest(input: {
    readonly nodeId: string;
    readonly environment: DatabaseContainmentAuditEvent["environment"];
  }): Promise<DatabaseContainmentAuditEvent | null> {
    const nowNs = BigInt(Date.now()) * 1_000_000n;
    const rows = await this.loki.queryRange({
      query: `{env="${escapeLogQl(this.lokiEnvironment)}",service="operator"} | json | event="database_containment_transition" | nodeId="${escapeLogQl(input.nodeId)}" | environment="${escapeLogQl(input.environment)}"`,
      startNs: String(nowNs - 30n * 24n * 60n * 60n * 1_000_000_000n),
      endNs: String(nowNs),
      limit: 1,
    });
    if (!rows[0]) return null;
    const parsed = JSON.parse(rows[0].line) as DatabaseContainmentAuditEvent;
    return parsed.incidentId && parsed.occurredAt ? parsed : null;
  }
}

export interface CherryFenceBinding {
  readonly ipId: string;
  readonly serverId: number;
}

/** Detaches only the node/cell IP route; it never changes another VM or global rule. */
export class CherryDatabaseSourceFenceAdapter implements DatabaseSourceFence {
  private readonly baseUrl: string;

  constructor(
    private readonly config: {
      readonly authToken: string;
      readonly timeoutMs: number;
      readonly resolveBinding: (input: {
        nodeSlug: string;
        environment: DatabaseContainmentAuditEvent["environment"];
      }) => Promise<CherryFenceBinding>;
      readonly baseUrl?: string;
      readonly fetchImpl?: typeof fetch;
    }
  ) {
    if (!config.authToken || !config.resolveBinding) {
      throw new Error("cherry_database_fence_config_invalid");
    }
    this.baseUrl = (
      config.baseUrl ?? "https://api.cherryservers.com/v1"
    ).replace(/\/$/, "");
  }

  async isFenced(
    input: Parameters<DatabaseSourceFence["isFenced"]>[0]
  ): Promise<boolean> {
    const binding = await this.config.resolveBinding(input);
    const ip = await this.request<{
      targeted_to?: number | null;
      server?: { id?: number };
    }>(`/ips/${encodeURIComponent(binding.ipId)}`);
    return (ip.targeted_to ?? ip.server?.id ?? null) !== binding.serverId;
  }

  async setFenced(
    input: Parameters<DatabaseSourceFence["setFenced"]>[0]
  ): Promise<void> {
    const binding = await this.config.resolveBinding(input);
    await this.request(`/ips/${encodeURIComponent(binding.ipId)}`, {
      method: "PUT",
      body: JSON.stringify({
        targeted_to: input.fenced ? null : binding.serverId,
        configure: "true",
      }),
    });
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await (this.config.fetchImpl ?? fetch)(
      `${this.baseUrl}${path}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${this.config.authToken}`,
          Accept: "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
        signal: AbortSignal.timeout(this.config.timeoutMs),
      }
    );
    if (!response.ok)
      throw new Error(`cherry_database_fence_http_${response.status}`);
    return (await response.json()) as T;
  }
}

function escapeLogQl(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
