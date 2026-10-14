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
    if (
      decodeURIComponent(url.username) !== "database_reliability_actuator" ||
      url.pathname !== "/postgres"
    ) {
      throw new Error("database_control_dsn_not_least_privilege");
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
  readonly ruleId: string;
  readonly sourceCidr: string;
}

export interface CherryHostFirewallRuleClient {
  getRule(input: { readonly ruleId: string }): Promise<{
    readonly ruleId: string;
    readonly sourceCidr: string;
    readonly enabled: boolean;
  } | null>;
  setRuleEnabled(input: {
    readonly ruleId: string;
    readonly expectedSourceCidr: string;
    readonly enabled: boolean;
  }): Promise<void>;
}

/** Mutates only one catalog-declared source-CIDR rule on a Cherry host. */
export class CherryDatabaseSourceFenceAdapter implements DatabaseSourceFence {
  constructor(
    private readonly config: {
      readonly firewallRules: CherryHostFirewallRuleClient;
      readonly resolveBindings: (input: {
        nodeSlug: string;
        environment: DatabaseContainmentAuditEvent["environment"];
      }) => Promise<readonly CherryFenceBinding[]>;
    }
  ) {
    if (!config.firewallRules || !config.resolveBindings) {
      throw new Error("cherry_database_fence_config_invalid");
    }
  }

  async isFenced(
    input: Parameters<DatabaseSourceFence["isFenced"]>[0]
  ): Promise<boolean> {
    const binding = await this.binding(input);
    const rule = await this.config.firewallRules.getRule({
      ruleId: binding.ruleId,
    });
    if (!rule || rule.sourceCidr !== binding.sourceCidr) {
      throw new Error("cherry_database_fence_rule_identity_mismatch");
    }
    return !rule.enabled;
  }

  async setFenced(
    input: Parameters<DatabaseSourceFence["setFenced"]>[0]
  ): Promise<void> {
    const binding = await this.binding(input);
    const rule = await this.config.firewallRules.getRule({
      ruleId: binding.ruleId,
    });
    if (!rule || rule.sourceCidr !== binding.sourceCidr) {
      throw new Error("cherry_database_fence_rule_identity_mismatch");
    }
    await this.config.firewallRules.setRuleEnabled({
      ruleId: binding.ruleId,
      expectedSourceCidr: binding.sourceCidr,
      enabled: !input.fenced,
    });
  }

  private async binding(input: {
    readonly nodeSlug: string;
    readonly environment: DatabaseContainmentAuditEvent["environment"];
  }): Promise<CherryFenceBinding> {
    const bindings = await this.config.resolveBindings(input);
    if (bindings.length !== 1) {
      throw new Error("cherry_database_fence_binding_not_unique");
    }
    const binding = bindings[0];
    if (!binding || !binding.ruleId || !isIpv4Cidr(binding.sourceCidr)) {
      throw new Error("cherry_database_fence_binding_invalid");
    }
    return binding;
  }
}

function isIpv4Cidr(value: string): boolean {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d|[12]\d|3[0-2])$/.exec(value);
  return Boolean(match?.[1]?.split(".").every((octet) => Number(octet) <= 255));
}

function escapeLogQl(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
