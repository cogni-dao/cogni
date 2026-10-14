// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it, vi } from "vitest";
import type {
  DatabaseContainmentAction,
  DatabaseDsnSecretsPlanePort,
} from "@/ports";
import {
  CherryDatabaseCellAdapter,
  PostgresCherryDatabaseCellProvisionLease,
} from "../compute/cherry-database-cell.adapter";
import {
  CherryDatabaseSourceFenceAdapter,
  createPostgresDatabaseContainmentAdapter,
  createPostgresDatabaseReadmissionAdapter,
  createProductionCherryDatabaseCellAdapter,
  createProductionDatabaseContainmentAdapter,
  createProductionDatabaseReadmissionAdapter,
  type DatabaseContainmentAuditEvent,
  DatabaseContainmentConfigurationError,
  DatabaseDsnRotationAdapter,
  DatabaseDsnRotationError,
  executeDatabaseCellLifecycleCommand,
  PinoLokiDatabaseContainmentAuditAdapter,
  PostgresAdminSqlAdapter,
  PostgresDatabaseCellVerifier,
  PostgresDatabaseContainmentAdapter,
  PostgresDatabaseReadmissionAdapter,
  PostgresReadmitSqlAdapter,
} from "./database-containment-production.adapter";

const ACTION: DatabaseContainmentAction = {
  nodeId: "00000000-0000-4000-8000-000000000011",
  nodeSlug: "alpha",
  environment: "candidate-a",
  incidentId: "incident-1",
  reason: "critical_io_pressure",
  actorId: "human:test",
  desiredTier: "dedicated",
  budgetProfile: "dedicated-high-throughput-v1",
};

function createPostgresProvisionLeaseHarness() {
  const tails = new Map<string, Promise<void>>();
  const keys: string[] = [];
  const sql = {
    async reserve() {
      let releaseLock = () => {};
      return {
        async unsafe(statement: string, params: readonly unknown[]) {
          const key = String(params[0]);
          if (statement.includes("pg_advisory_lock(")) {
            keys.push(key);
            const prior = tails.get(key) ?? Promise.resolve();
            const current = new Promise<void>((resolve) => {
              releaseLock = resolve;
            });
            tails.set(
              key,
              prior.then(() => current)
            );
            await prior;
            return [{}];
          }
          if (statement.includes("pg_advisory_unlock(")) {
            releaseLock();
            return [{ released: true }];
          }
          throw new Error(`unexpected_lock_query:${statement}`);
        },
        release() {},
      };
    },
  };
  return {
    keys,
    lease: new PostgresCherryDatabaseCellProvisionLease(sql as never),
  };
}

describe("PostgresDatabaseContainmentAdapter", () => {
  it("rejects a non-Postgres privileged DSN", () => {
    expect(() => new PostgresAdminSqlAdapter("https://db.example")).toThrow(
      "database_control_dsn_invalid"
    );
    expect(
      () => new PostgresAdminSqlAdapter("postgresql://postgres:pw@db/postgres")
    ).toThrow("database_control_dsn_not_least_privilege");
    expect(
      () =>
        new PostgresReadmitSqlAdapter(
          "postgresql://database_reliability_actuator:pw@db/postgres"
        )
    ).toThrow("database_readmit_dsn_not_least_privilege");
  });

  it("writes structured audit and reads the latest transition from Loki", async () => {
    const info = vi.fn();
    let durableQuery = "";
    const queryRange = async (input: { readonly query: string }) => {
      durableQuery = input.query;
      return [
        {
          ts: "1",
          line: JSON.stringify({
            ...ACTION,
            action: "contained",
            occurredAt: "2026-10-13T23:30:00.000Z",
          }),
        },
      ];
    };
    const adapter = new PinoLokiDatabaseContainmentAuditAdapter(
      { info } as never,
      { queryRange },
      "candidate-a"
    );
    await adapter.append({
      ...ACTION,
      action: "contained",
      occurredAt: "2026-10-13T23:30:00.000Z",
    });
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "database_containment_transition" }),
      "database_containment_transition"
    );
    await expect(adapter.latest(ACTION)).resolves.toMatchObject({
      incidentId: "incident-1",
      action: "contained",
    });
    expect(durableQuery).toContain(
      'service=~"database-reliability-actuator|database-reliability-readmitter"'
    );
    expect(durableQuery).not.toContain('service="operator"');
  });

  it("fences node A's source-CIDR rule while preserving node B access", async () => {
    const rules = new Map([
      [
        "rule-a",
        { ruleId: "rule-a", sourceCidr: "203.0.113.10/32", enabled: true },
      ],
      [
        "rule-b",
        { ruleId: "rule-b", sourceCidr: "203.0.113.11/32", enabled: true },
      ],
    ]);
    const mutations: string[] = [];
    const adapter = new CherryDatabaseSourceFenceAdapter({
      resolveBindings: async ({ nodeSlug }) => [
        nodeSlug === "alpha"
          ? { ruleId: "rule-a", sourceCidr: "203.0.113.10/32" }
          : { ruleId: "rule-b", sourceCidr: "203.0.113.11/32" },
      ],
      firewallRules: {
        getRule: async ({ ruleId }) => rules.get(ruleId) ?? null,
        setRuleEnabled: async ({ ruleId, expectedSourceCidr, enabled }) => {
          const current = rules.get(ruleId);
          if (!current || current.sourceCidr !== expectedSourceCidr)
            throw new Error("identity mismatch");
          mutations.push(ruleId);
          rules.set(ruleId, { ...current, enabled });
        },
      },
    });
    await adapter.setFenced({ ...ACTION, fenced: true });
    expect(mutations).toEqual(["rule-a"]);
    expect(rules.get("rule-a")?.enabled).toBe(false);
    expect(rules.get("rule-b")?.enabled).toBe(true);
    await expect(adapter.isFenced(ACTION)).resolves.toBe(true);
    await expect(
      adapter.isFenced({ ...ACTION, nodeSlug: "bravo" })
    ).resolves.toBe(false);
  });

  it("fails closed without a unique source-CIDR binding", async () => {
    const setRuleEnabled = vi.fn();
    const adapter = new CherryDatabaseSourceFenceAdapter({
      resolveBindings: async () => [
        { ruleId: "rule-a", sourceCidr: "203.0.113.10/32" },
        { ruleId: "rule-b", sourceCidr: "203.0.113.11/32" },
      ],
      firewallRules: {
        getRule: vi.fn(),
        setRuleEnabled,
      },
    });
    await expect(
      adapter.setFenced({ ...ACTION, fenced: true })
    ).rejects.toThrow("cherry_database_fence_binding_not_unique");
    expect(setRuleEnabled).not.toHaveBeenCalled();
  });

  it("fails closed when a privileged production capability is absent", () => {
    expect(() =>
      createPostgresDatabaseContainmentAdapter({
        sql: undefined,
        fenceStatus: undefined,
        audit: undefined,
      } as never)
    ).toThrowError(DatabaseContainmentConfigurationError);
  });

  it("contains and readmits through disjoint typed capabilities", async () => {
    let canLogin = true;
    let sessions = 8;
    const fenced = false;
    const statements: string[] = [];
    const events: DatabaseContainmentAuditEvent[] = [];
    const sql = {
      async query<T extends Record<string, unknown>>(
        statement: string,
        params: readonly unknown[] = []
      ): Promise<readonly T[]> {
        statements.push(statement);
        if (
          statement.includes("contain_database_role") ||
          statement.includes("readmit_database_role")
        ) {
          expect(params[0]).toMatch(/^(app|service)_alpha$/);
          canLogin = statement.includes("readmit_database_role");
          if (!canLogin) sessions = 0;
          return [];
        }
        if (statement.includes("FROM pg_roles")) {
          return ["app_alpha", "service_alpha"].map((rolname) => ({
            rolname,
            rolcanlogin: canLogin,
          })) as unknown as readonly T[];
        }
        if (statement.includes("count(*)")) {
          return [{ count: sessions }] as unknown as readonly T[];
        }
        throw new Error(`unexpected SQL: ${statement}`);
      },
    };
    const adapter = new PostgresDatabaseContainmentAdapter({
      sql,
      fenceStatus: {
        isFenced: async () => fenced,
      },
      audit: {
        append: async (event) => {
          events.push(event);
        },
        latest: async () => events.at(-1) ?? null,
      },
      now: () => new Date("2026-10-13T23:30:00.000Z"),
    });
    const readmitter = new PostgresDatabaseReadmissionAdapter({
      readmitSql: sql,
      status: adapter,
      audit: {
        append: async (event) => {
          events.push(event);
        },
      },
      now: () => new Date("2026-10-13T23:30:00.000Z"),
    });

    const contained = await adapter.contain(ACTION);
    expect(contained).toMatchObject({
      phase: "contained",
      contained: true,
      activeSessions: 0,
      rolesPresent: true,
      rolesCanLogin: false,
      firewallFenced: false,
      incidentId: "incident-1",
      reason: "critical_io_pressure",
      lastTransitionAt: "2026-10-13T23:30:00.000Z",
    });

    const open = await readmitter.readmit(ACTION);
    expect(open).toMatchObject({
      phase: "open",
      contained: false,
      rolesCanLogin: true,
      firewallFenced: false,
      incidentId: "incident-1",
    });
    expect(events.map((event) => event.action)).toEqual([
      "containment_requested",
      "contained",
      "readmission_requested",
      "readmitted",
    ]);
    expect(
      statements.filter((statement) =>
        /(?:contain|readmit)_database_role/.test(statement)
      )
    ).toHaveLength(4);
    expect(
      statements.some((statement) => statement.startsWith("ALTER ROLE"))
    ).toBe(false);
    expect(
      statements.some((statement) => statement.includes("pg_terminate_backend"))
    ).toBe(false);
  });

  it("audits intent and partial failure without calling the firewall", async () => {
    const events: DatabaseContainmentAuditEvent[] = [];
    const adapter = new PostgresDatabaseContainmentAdapter({
      sql: {
        query: async () => {
          throw new Error("admin_sql_failed");
        },
      },
      fenceStatus: { isFenced: async () => false },
      audit: {
        append: async (event) => {
          events.push(event);
        },
        latest: async () => events.at(-1) ?? null,
      },
    });
    await expect(adapter.contain(ACTION)).rejects.toThrow("admin_sql_failed");
    expect(events.map((event) => [event.action, event.errorCode])).toEqual([
      ["containment_requested", undefined],
      ["containment_failed", "admin_sql_failed"],
    ]);
  });

  it("constructs role-only production containment without host control", async () => {
    const adapter = createProductionDatabaseContainmentAdapter({
      adminDsn:
        "postgresql://database_reliability_actuator:secret@db.internal:5432/postgres",
      log: { info: vi.fn() } as never,
      loki: { queryRange: vi.fn() } as never,
      lokiEnvironment: "candidate-a",
    });
    expect(adapter).toEqual(
      expect.objectContaining({
        contain: expect.any(Function),
        status: expect.any(Function),
      })
    );
  });

  it("constructs isolated readmission without Loki read credentials", () => {
    const readmitter = createProductionDatabaseReadmissionAdapter({
      readmitDsn:
        "postgresql://database_reliability_readmitter:secret@db.internal:5432/postgres",
      status: { status: vi.fn() },
      log: { info: vi.fn() } as never,
    });
    expect(readmitter.readmit).toEqual(expect.any(Function));
  });

  it.each([
    {
      name: "status read fails",
      roleRows: null,
      error: "status_failed",
    },
    {
      name: "roles remain mixed",
      roleRows: [
        { rolname: "app_alpha", rolcanlogin: false },
        { rolname: "service_alpha", rolcanlogin: true },
      ],
      error: "database_containment_not_confirmed",
    },
  ])("never audits contained when $name", async ({ roleRows, error }) => {
    const events: DatabaseContainmentAuditEvent[] = [];
    const adapter = new PostgresDatabaseContainmentAdapter({
      sql: {
        query: async <T extends Record<string, unknown>>(statement: string) => {
          if (statement.includes("contain_database_role")) {
            return [];
          }
          if (statement.includes("FROM pg_roles")) {
            if (roleRows === null) throw new Error("status_failed");
            return roleRows as unknown as readonly T[];
          }
          return [{ count: 0 }] as unknown as readonly T[];
        },
      },
      fenceStatus: { isFenced: async () => false },
      audit: {
        append: async (event) => {
          events.push(event);
        },
        latest: async () => events.at(-1) ?? null,
      },
    });
    await expect(adapter.contain(ACTION)).rejects.toThrow(error);
    expect(events.map((event) => event.action)).toEqual([
      "containment_requested",
      "containment_failed",
    ]);
  });

  it("rejects automated readmission before changing roles", async () => {
    const query = vi.fn();
    const append = vi.fn();
    const adapter = createPostgresDatabaseReadmissionAdapter({
      readmitSql: { query },
      status: { status: vi.fn() },
      audit: { append },
    });
    await expect(
      adapter.readmit({ ...ACTION, actorId: "system:reliability-policy" })
    ).rejects.toThrow("database_readmission_requires_human_actor");
    expect(query).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it("fails closed when either exact per-node role is absent", async () => {
    const adapter = new PostgresDatabaseContainmentAdapter({
      sql: {
        query: async <T extends Record<string, unknown>>(statement: string) =>
          (statement.includes("FROM pg_roles")
            ? []
            : [{ count: 0 }]) as unknown as readonly T[],
      },
      audit: { append: vi.fn(), latest: async () => null },
    });
    await expect(adapter.status(ACTION)).resolves.toMatchObject({
      rolesPresent: false,
      contained: false,
      phase: "recovering",
      firewallFenced: null,
    });
  });

  it("reports a mixed LOGIN/NOLOGIN role state as recovering", async () => {
    const adapter = new PostgresDatabaseContainmentAdapter({
      sql: {
        query: async <T extends Record<string, unknown>>(statement: string) =>
          (statement.includes("FROM pg_roles")
            ? [
                { rolname: "app_alpha", rolcanlogin: false },
                { rolname: "service_alpha", rolcanlogin: true },
              ]
            : [{ count: 0 }]) as unknown as readonly T[],
      },
      fenceStatus: { isFenced: async () => false },
      audit: { append: vi.fn(), latest: async () => null },
    });
    await expect(adapter.status(ACTION)).resolves.toMatchObject({
      rolesPresent: true,
      rolesCanLogin: false,
      activeSessions: 0,
      contained: false,
      phase: "recovering",
    });
  });
});

describe("DatabaseDsnRotationAdapter", () => {
  const target = {
    app: "postgresql://app_alpha:a@10.0.0.2:5432/cogni_alpha",
    service: "postgresql://service_alpha:b@10.0.0.2:5432/cogni_alpha",
  };
  const source = {
    app: "postgresql://app_alpha:c@10.0.0.1:5432/cogni_alpha",
    service: "postgresql://service_alpha:d@10.0.0.1:5432/cogni_alpha",
  };

  it("snapshots the live pair and CAS-writes both DSNs before verification", async () => {
    const calls: string[] = [];
    const writes: Readonly<Record<string, string>>[] = [];
    const secrets: DatabaseDsnSecretsPlanePort = {
      readSecrets: async () => {
        calls.push("read");
        return {
          version: 8,
          path: "cogni/candidate-a/alpha",
          values: {
            DATABASE_URL: source.app,
            DATABASE_SERVICE_URL: source.service,
          },
        };
      },
      compareAndSwapSecrets: async ({ expectedVersion, values }) => {
        calls.push(`cas:${expectedVersion}`);
        writes.push(values);
        return {
          written: true,
          version: 9,
          path: "cogni/candidate-a/alpha",
          keys: Object.keys(values),
        };
      },
    };
    const adapter = new DatabaseDsnRotationAdapter({
      secrets,
      sync: {
        forceAndWait: async ({ openBaoVersion }) => {
          calls.push(`sync:${openBaoVersion}`);
          return { receiptId: `eso-${openBaoVersion}` };
        },
      },
      verifier: {
        verify: async () => {
          calls.push("verify");
          return { endpointFingerprint: "db:dedicated:alpha" };
        },
      },
      audit: {
        append: async () => {
          calls.push("audit");
        },
      },
    });

    const result = await adapter.rotate({
      ...ACTION,
      targetCellId: "cell-7",
      targetCellEndpoint: "10.0.0.2",
      target,
    });
    expect(calls).toEqual(["read", "cas:8", "sync:9", "verify", "audit"]);
    expect(writes[0]).toEqual({
      DATABASE_URL: target.app,
      DATABASE_SERVICE_URL: target.service,
    });
    expect(result).toMatchObject({
      openBaoVersion: 9,
      syncReceiptId: "eso-9",
      targetCellId: "cell-7",
    });
  });

  it("CAS-restores the captured live source when verification fails", async () => {
    const writes: Readonly<Record<string, string>>[] = [];
    const auditActions: string[] = [];
    let version = 8;
    const adapter = new DatabaseDsnRotationAdapter({
      secrets: {
        readSecrets: async () => ({
          version,
          path: "cogni/candidate-a/alpha",
          values: {
            DATABASE_URL: source.app,
            DATABASE_SERVICE_URL: source.service,
          },
        }),
        compareAndSwapSecrets: async ({ expectedVersion, values }) => {
          expect(expectedVersion).toBe(version);
          writes.push(values);
          version += 1;
          return {
            written: true,
            version,
            path: "cogni/candidate-a/alpha",
            keys: Object.keys(values),
          };
        },
      },
      sync: {
        forceAndWait: async ({ openBaoVersion }) => ({
          receiptId: `eso-${openBaoVersion}`,
        }),
      },
      verifier: { verify: async () => Promise.reject(new Error("unready")) },
      audit: {
        append: async (event) => {
          auditActions.push(event.action);
        },
      },
    });

    await expect(
      adapter.rotate({
        ...ACTION,
        targetCellId: "cell-7",
        targetCellEndpoint: "10.0.0.2",
        target,
      })
    ).rejects.toBeInstanceOf(DatabaseDsnRotationError);
    expect(writes).toEqual([
      { DATABASE_URL: target.app, DATABASE_SERVICE_URL: target.service },
      {
        DATABASE_URL: source.app,
        DATABASE_SERVICE_URL: source.service,
      },
    ]);
    expect(auditActions).toEqual(["database_dsn_rollback"]);
  });

  it("reconciles an ambiguous target write only at the exact next version", async () => {
    let reads = 0;
    const sync = vi.fn(async () => ({ receiptId: "eso-9" }));
    const adapter = new DatabaseDsnRotationAdapter({
      secrets: {
        readSecrets: async () => {
          reads += 1;
          if (reads === 2) throw new TypeError("first readback unavailable");
          const pair = reads === 1 ? source : target;
          return {
            version: reads === 1 ? 8 : 9,
            path: "cogni/candidate-a/alpha",
            values: {
              DATABASE_URL: pair.app,
              DATABASE_SERVICE_URL: pair.service,
            },
          };
        },
        compareAndSwapSecrets: async () => {
          throw new TypeError("connection closed after request");
        },
      },
      sync: { forceAndWait: sync },
      verifier: {
        verify: async () => ({ endpointFingerprint: "db:dedicated:alpha" }),
      },
      audit: { append: vi.fn() },
    });

    await expect(
      adapter.rotate({
        ...ACTION,
        targetCellId: "cell-7",
        targetCellEndpoint: "10.0.0.2",
        target,
      })
    ).resolves.toMatchObject({ openBaoVersion: 9 });
    expect(sync).toHaveBeenCalledWith(
      expect.objectContaining({ openBaoVersion: 9 })
    );
    expect(reads).toBe(3);
  });

  it("never rolls back over an overlapping newer rotation", async () => {
    let casCalls = 0;
    const adapter = new DatabaseDsnRotationAdapter({
      secrets: {
        readSecrets: async () => ({
          version: 8,
          path: "cogni/candidate-a/alpha",
          values: {
            DATABASE_URL: source.app,
            DATABASE_SERVICE_URL: source.service,
          },
        }),
        compareAndSwapSecrets: async ({ values }) => {
          casCalls += 1;
          if (casCalls === 2) {
            throw Object.assign(new Error("conflict"), {
              code: "openbao_cas_conflict",
            });
          }
          return {
            written: true,
            version: 9,
            path: "cogni/candidate-a/alpha",
            keys: Object.keys(values),
          };
        },
      },
      sync: {
        forceAndWait: async ({ openBaoVersion }) => ({
          receiptId: `eso-${openBaoVersion}`,
        }),
      },
      verifier: { verify: async () => Promise.reject(new Error("unready")) },
      audit: { append: vi.fn() },
    });

    await expect(
      adapter.rotate({
        ...ACTION,
        targetCellId: "cell-7",
        targetCellEndpoint: "10.0.0.2",
        target,
      })
    ).rejects.toMatchObject({ code: "rollback_conflict" });
    expect(casCalls).toBe(2);
  });

  it.each([
    [
      "app role",
      {
        ...target,
        app: "postgresql://app_other:a@10.0.0.2:5432/cogni_alpha",
      },
      "database_dsn_app_role_mismatch",
    ],
    [
      "service role",
      {
        ...target,
        service: "postgresql://service_other:b@10.0.0.2:5432/cogni_alpha",
      },
      "database_dsn_service_role_mismatch",
    ],
    [
      "database",
      {
        ...target,
        service: "postgresql://service_alpha:b@10.0.0.2:5432/cogni_other",
      },
      "database_dsn_database_mismatch",
    ],
    ["cell endpoint", target, "database_dsn_cell_endpoint_mismatch"],
  ])("rejects a target with mismatched %s identity", async (_, pair, error) => {
    const readSecrets = vi.fn();
    const adapter = new DatabaseDsnRotationAdapter({
      secrets: {
        readSecrets,
        compareAndSwapSecrets: vi.fn(),
      },
      sync: { forceAndWait: vi.fn() },
      verifier: { verify: vi.fn() },
      audit: { append: vi.fn() },
    });
    await expect(
      adapter.rotate({
        ...ACTION,
        targetCellId: "cell-7",
        targetCellEndpoint:
          error === "database_dsn_cell_endpoint_mismatch"
            ? "10.0.0.99"
            : "10.0.0.2",
        target: pair,
      })
    ).rejects.toThrow(error);
    expect(readSecrets).not.toHaveBeenCalled();
  });
});

describe("CherryDatabaseCellAdapter", () => {
  it("verifies a target cell with its exact node identity and deterministic DB proof", async () => {
    const unsafe = vi
      .fn()
      .mockResolvedValueOnce([
        {
          table_name: "positions",
          column_name: "id",
          ordinal_position: 1,
          data_type: "uuid",
          is_nullable: "NO",
        },
      ])
      .mockResolvedValueOnce([
        { count: "2", hash_sum: "33", hash_min: "11", hash_max: "22" },
      ]);
    const end = vi.fn();
    const connect = vi.fn(() => ({ unsafe, end }) as never);
    const verifier = new PostgresDatabaseCellVerifier(
      {
        username: "app_alpha",
        password: "secret",
        database: "cogni_alpha",
      },
      connect
    );
    await expect(
      verifier.verify({
        cellId: "77",
        nodeId: ACTION.nodeId,
        nodeSlug: "alpha",
        endpoint: "10.0.0.2",
        action: "backup",
        backupLabel: "proof-v1",
        restorePointId: "rp-1",
      })
    ).resolves.toMatchObject({
      schemaFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      rowCount: 2,
      checksum: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({ host: "10.0.0.2", username: "app_alpha" })
    );
    expect(end).toHaveBeenCalled();
  });

  it("constructs zero-to-one lifecycle before the provider endpoint exists", () => {
    const cells = createProductionCherryDatabaseCellAdapter({
      authToken: "token",
      projectId: "99",
      timeoutMs: 1000,
      region: "LT-Siauliai",
      plan: "B1-1-1gb-20s-shared",
      image: "ubuntu-24-04",
      storagePlanId: 500,
      sshKeyIds: [4],
      renderUserData: async () => "I2Nsb3VkLWNvbmZpZw==",
      lockDsn:
        "postgresql://database_reliability_actuator:secret@shared.internal:5432/postgres",
      verificationCredential: {
        username: "app_alpha",
        password: "secret",
        database: "cogni_alpha",
      },
    });
    expect(cells.provision).toEqual(expect.any(Function));
  });

  it("persists the terminal result from the bounded lifecycle caller", async () => {
    const result = {
      provider: "cherry",
      cellId: "77",
      nodeId: ACTION.nodeId,
      nodeSlug: "alpha",
      environment: "candidate-a" as const,
      phase: "ready" as const,
      endpoint: "10.0.0.2",
      storage: { volumeId: "55", sizeGiB: 50 },
      observedAt: "2026-10-13T23:30:00.000Z",
    };
    const append = vi.fn();
    await expect(
      executeDatabaseCellLifecycleCommand(
        { status: vi.fn(async () => result) } as never,
        { append },
        { action: "status", input: { cellId: "77" } }
      )
    ).resolves.toEqual(result);
    expect(append).toHaveBeenCalledWith({
      event: "database_cell_lifecycle_receipt",
      command: "status",
      result,
    });
  });

  it("leases the full reconcile so concurrent calls create one volume and server", async () => {
    const requests: string[] = [];
    const leaseHarness = createPostgresProvisionLeaseHarness();
    let storageCreated = false;
    let serverCreated = false;
    const tags = {
      "cogni.io/node-id": ACTION.nodeId,
      "cogni.io/node-slug": "alpha",
      "cogni.io/environment": "candidate-a",
      "cogni.io/database-tier": "dedicated",
      "cogni.io/budget-profile": "dedicated-high-throughput-v1",
      "cogni.io/idempotency-key": "alpha-candidate-a-v1",
      "cogni.io/storage-gib": "50",
      "cogni.io/storage-id": "55",
    };
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const path = String(url);
      const method = init?.method ?? "GET";
      requests.push(`${method} ${path}`);
      if (path.endsWith("/projects/99/servers") && method === "GET") {
        return Response.json(
          serverCreated
            ? [{ id: 77, state: "pending", ip_addresses: [], tags }]
            : []
        );
      }
      if (path.endsWith("/projects/99/storages") && method === "GET") {
        return Response.json(
          storageCreated
            ? [
                {
                  id: 55,
                  description: "cogni-db-cell-alpha-candidate-a-v1",
                  size: 50,
                  region: "LT-Siauliai",
                },
              ]
            : []
        );
      }
      if (path.endsWith("/projects/99/storages") && method === "POST") {
        storageCreated = true;
        return Response.json(
          {
            id: 55,
            description: "cogni-db-cell-alpha-candidate-a-v1",
            size: 50,
            region: "LT-Siauliai",
          },
          { status: 201 }
        );
      }
      serverCreated = true;
      return Response.json(
        { id: 77, state: "pending", ip_addresses: [] },
        { status: 201 }
      );
    });
    const makeAdapter = () =>
      new CherryDatabaseCellAdapter({
        authToken: "token",
        projectId: "99",
        timeoutMs: 1000,
        region: "LT-Siauliai",
        plan: "B1-1-1gb-20s-shared",
        image: "ubuntu-24-04",
        storagePlanId: 500,
        sshKeyIds: [4],
        renderUserData: async () => "I2Nsb3VkLWNvbmZpZw==",
        provisionLease: leaseHarness.lease,
        fetchImpl,
        now: () => new Date("2026-10-13T23:30:00.000Z"),
      });
    const input = {
      nodeId: ACTION.nodeId,
      nodeSlug: "alpha",
      environment: "candidate-a" as const,
      databaseTier: "dedicated" as const,
      budgetProfile: "dedicated-high-throughput-v1",
      idempotencyKey: "alpha-candidate-a-v1",
      storageGiB: 50,
    };
    const [cellResult, retryResult, collisionResult] = await Promise.allSettled(
      [
        makeAdapter().provision(input),
        makeAdapter().provision(input),
        makeAdapter().provision({
          ...input,
          nodeId: "different-node-id",
          nodeSlug: "neighbor",
        }),
      ]
    );
    expect(cellResult.status).toBe("fulfilled");
    expect(retryResult.status).toBe("fulfilled");
    expect(collisionResult).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        message: "database_cell_identity_mismatch:cogni.io/node-id",
      }),
    });
    if (
      cellResult.status !== "fulfilled" ||
      retryResult.status !== "fulfilled"
    ) {
      throw new Error("expected same-identity provision calls to succeed");
    }
    const cell = cellResult.value;
    const retry = retryResult.value;
    expect(requests[1]).toContain(
      "GET https://api.cherryservers.com/v1/projects/99/storages"
    );
    expect(requests[2]).toContain(
      "POST https://api.cherryservers.com/v1/projects/99/storages"
    );
    expect(requests[3]).toContain("/servers");
    expect(
      requests.filter((request) => request.startsWith("POST"))
    ).toHaveLength(2);
    expect(leaseHarness.keys).toEqual([
      "cherry-database-cell:99:alpha-candidate-a-v1",
      "cherry-database-cell:99:alpha-candidate-a-v1",
      "cherry-database-cell:99:alpha-candidate-a-v1",
    ]);
    expect(cell).toMatchObject({
      cellId: "77",
      phase: "provisioning",
      endpoint: null,
      storage: { volumeId: "55", sizeGiB: 50 },
    });
    expect(retry.cellId).toBe("77");
    expect(cell).not.toHaveProperty("authToken");
  });

  it("fails closed before provider I/O when no provision lease is injected", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const adapter = new CherryDatabaseCellAdapter({
      authToken: "token",
      projectId: "99",
      timeoutMs: 1000,
      region: "LT-Siauliai",
      plan: "B1-1-1gb-20s-shared",
      image: "ubuntu-24-04",
      storagePlanId: 500,
      sshKeyIds: [4],
      renderUserData: async () => "I2Nsb3VkLWNvbmZpZw==",
      fetchImpl,
    });
    await expect(
      adapter.provision({
        nodeId: ACTION.nodeId,
        nodeSlug: "alpha",
        environment: "candidate-a",
        databaseTier: "dedicated",
        budgetProfile: "dedicated-high-throughput-v1",
        idempotencyKey: "alpha-candidate-a-v1",
        storageGiB: 50,
      })
    ).rejects.toThrow("cherry_database_cell_provision_lease_required");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reuses the deterministic volume after an unknown server-create outcome", async () => {
    const requests: string[] = [];
    const storage = {
      id: 55,
      description: "cogni-db-cell-alpha-candidate-a-v1",
      size: 50,
      region: "LT-Siauliai",
    };
    let storageCreated = false;
    let serverAttempts = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const path = String(url);
      const method = init?.method ?? "GET";
      requests.push(`${method} ${path}`);
      if (path.endsWith("/projects/99/servers") && method === "GET") {
        return Response.json([]);
      }
      if (path.endsWith("/projects/99/storages") && method === "GET") {
        return Response.json(storageCreated ? [storage] : []);
      }
      if (path.endsWith("/projects/99/storages") && method === "POST") {
        storageCreated = true;
        return Response.json(storage, { status: 201 });
      }
      serverAttempts += 1;
      if (serverAttempts === 1)
        throw new Error("unknown_server_create_outcome");
      return Response.json(
        { id: 77, state: "pending", ip_addresses: [] },
        { status: 201 }
      );
    });
    const adapter = new CherryDatabaseCellAdapter({
      authToken: "token",
      projectId: "99",
      timeoutMs: 1000,
      region: "LT-Siauliai",
      plan: "B1-1-1gb-20s-shared",
      image: "ubuntu-24-04",
      storagePlanId: 500,
      sshKeyIds: [4],
      renderUserData: async () => "I2Nsb3VkLWNvbmZpZw==",
      provisionLease: createPostgresProvisionLeaseHarness().lease,
      fetchImpl,
    });
    const input = {
      nodeId: ACTION.nodeId,
      nodeSlug: "alpha",
      environment: "candidate-a" as const,
      databaseTier: "dedicated" as const,
      budgetProfile: "dedicated-high-throughput-v1",
      idempotencyKey: "alpha-candidate-a-v1",
      storageGiB: 50,
    };
    await expect(adapter.provision(input)).rejects.toThrow(
      "unknown_server_create_outcome"
    );
    await expect(adapter.provision(input)).resolves.toMatchObject({
      cellId: "77",
      storage: { volumeId: "55", sizeGiB: 50 },
    });
    expect(
      requests.filter(
        (request) =>
          request ===
          "POST https://api.cherryservers.com/v1/projects/99/storages"
      )
    ).toHaveLength(1);
  });

  it("fails closed when a durable idempotency identity belongs to another node", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith("/projects/99/servers")) {
        return Response.json([
          {
            id: 77,
            state: "active",
            tags: {
              "cogni.io/node-id": "other-node-id",
              "cogni.io/node-slug": "neighbor",
              "cogni.io/environment": "candidate-a",
              "cogni.io/database-tier": "dedicated",
              "cogni.io/budget-profile": "dedicated-high-throughput-v1",
              "cogni.io/idempotency-key": "alpha-candidate-a-v1",
              "cogni.io/storage-gib": "50",
              "cogni.io/storage-id": "55",
            },
          },
        ]);
      }
      throw new Error("unexpected_request");
    });
    const adapter = new CherryDatabaseCellAdapter({
      authToken: "token",
      projectId: "99",
      timeoutMs: 1000,
      region: "LT-Siauliai",
      plan: "B1-1-1gb-20s-shared",
      image: "ubuntu-24-04",
      storagePlanId: 500,
      sshKeyIds: [4],
      renderUserData: async () => "I2Nsb3VkLWNvbmZpZw==",
      provisionLease: createPostgresProvisionLeaseHarness().lease,
      fetchImpl,
    });
    await expect(
      adapter.provision({
        nodeId: ACTION.nodeId,
        nodeSlug: "alpha",
        environment: "candidate-a",
        databaseTier: "dedicated",
        budgetProfile: "dedicated-high-throughput-v1",
        idempotencyKey: "alpha-candidate-a-v1",
        storageGiB: 50,
      })
    ).rejects.toThrow("database_cell_identity_mismatch:cogni.io/node-id");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("binds terminal backup/restore actions to one restore point and DB proof", async () => {
    const requests: Array<{ path: string; body?: string }> = [];
    const actions: Array<Record<string, unknown>> = [];
    const verification = {
      schemaFingerprint: "schema-v7",
      rowCount: 42,
      checksum: "sha256:database-proof",
    };
    const verify = vi.fn(async () => verification);
    const tags = {
      "cogni.io/node-id": ACTION.nodeId,
      "cogni.io/node-slug": "alpha",
      "cogni.io/environment": "candidate-a",
      "cogni.io/database-tier": "dedicated",
      "cogni.io/budget-profile": "dedicated-high-throughput-v1",
      "cogni.io/idempotency-key": "alpha-candidate-a-v1",
      "cogni.io/storage-gib": "50",
      "cogni.io/storage-id": "55",
    };
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const path = String(url);
      const method = init?.method ?? "GET";
      requests.push({ path: `${method} ${path}`, body: init?.body as string });
      if (path.endsWith("/servers/77") && method === "GET") {
        return Response.json({
          id: 77,
          state: "active",
          tags,
          ip_addresses: [{ address: "10.0.0.2", type: "primary-ip" }],
          backup: { id: 900 },
        });
      }
      if (path.endsWith("/servers/77/actions") && method === "GET") {
        return Response.json(actions);
      }
      if (path.endsWith("/servers/77/actions") && method === "POST") {
        const body = JSON.parse(String(init?.body)) as {
          type: "backup" | "restore";
          label: string;
        };
        actions.push({
          id: body.type === "backup" ? 501 : 502,
          type: body.type,
          label: body.label,
          status: "completed",
          completed_at: "2026-10-14T02:29:59.000Z",
        });
        return Response.json({ id: 77, state: "active" }, { status: 201 });
      }
      if (path.endsWith("/backups/900/restore-points")) {
        return Response.json([
          {
            id: "restore-point-44",
            label: "alpha-candidate-a-pre-cutover-v1",
            status: "available",
          },
        ]);
      }
      throw new Error(`unexpected_request:${method}:${path}`);
    });
    const adapter = new CherryDatabaseCellAdapter({
      authToken: "token",
      projectId: "99",
      timeoutMs: 1000,
      region: "LT-Siauliai",
      plan: "B1-1-1gb-20s-shared",
      image: "ubuntu-24-04",
      storagePlanId: 500,
      sshKeyIds: [4],
      renderUserData: async () => "I2Nsb3VkLWNvbmZpZw==",
      databaseVerifier: { verify },
      actionPollAttempts: 2,
      actionPollIntervalMs: 0,
      sleep: async () => {},
      fetchImpl,
      now: () => new Date("2026-10-14T02:30:00.000Z"),
    });
    const backupReceipt = await adapter.backup({
      cellId: "77",
      expectedNodeId: ACTION.nodeId,
      backupLabel: "alpha-candidate-a-pre-cutover-v1",
    });
    expect(backupReceipt).toMatchObject({
      action: "backup",
      cellId: "77",
      providerActionId: "501",
      restorePointId: "restore-point-44",
      completedAt: "2026-10-14T02:29:59.000Z",
      verification,
    });
    const restoreReceipt = await adapter.restore({
      cellId: "77",
      expectedNodeId: ACTION.nodeId,
      backupLabel: "alpha-candidate-a-pre-cutover-v1",
    });
    expect(restoreReceipt).toMatchObject({
      action: "restore",
      cellId: "77",
      providerActionId: "502",
      restorePointId: "restore-point-44",
      verification,
    });
    expect(verify).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        action: "restore",
        endpoint: "10.0.0.2",
        restorePointId: "restore-point-44",
      })
    );
    expect(requests.map(({ path }) => path)).toEqual([
      "GET https://api.cherryservers.com/v1/servers/77",
      "GET https://api.cherryservers.com/v1/servers/77/actions",
      "POST https://api.cherryservers.com/v1/servers/77/actions",
      "GET https://api.cherryservers.com/v1/servers/77/actions",
      "GET https://api.cherryservers.com/v1/backups/900/restore-points",
      "GET https://api.cherryservers.com/v1/servers/77",
      "GET https://api.cherryservers.com/v1/backups/900/restore-points",
      "GET https://api.cherryservers.com/v1/servers/77/actions",
      "POST https://api.cherryservers.com/v1/servers/77/actions",
      "GET https://api.cherryservers.com/v1/servers/77/actions",
      "GET https://api.cherryservers.com/v1/backups/900/restore-points",
    ]);
    expect(requests[2]?.body).toBe(
      JSON.stringify({
        type: "backup",
        label: "alpha-candidate-a-pre-cutover-v1",
      })
    );
    expect(requests[8]?.body).toBe(
      JSON.stringify({
        type: "restore",
        label: "alpha-candidate-a-pre-cutover-v1",
      })
    );
  });

  it("does not return a receipt while the Cherry action is non-terminal", async () => {
    const tags = {
      "cogni.io/node-id": ACTION.nodeId,
      "cogni.io/node-slug": "alpha",
      "cogni.io/environment": "candidate-a",
      "cogni.io/database-tier": "dedicated",
      "cogni.io/budget-profile": "dedicated-high-throughput-v1",
      "cogni.io/idempotency-key": "alpha-candidate-a-v1",
      "cogni.io/storage-gib": "50",
      "cogni.io/storage-id": "55",
    };
    let actionPosted = false;
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const path = String(url);
      const method = init?.method ?? "GET";
      if (path.endsWith("/servers/77")) {
        return Response.json({
          id: 77,
          state: "active",
          tags,
          ip_addresses: [{ address: "10.0.0.2" }],
          backup: { id: 900 },
        });
      }
      if (path.endsWith("/servers/77/actions") && method === "POST") {
        actionPosted = true;
        return Response.json({ id: 77 }, { status: 201 });
      }
      if (path.endsWith("/servers/77/actions")) {
        return Response.json(
          actionPosted
            ? [
                {
                  id: 501,
                  type: "backup",
                  label: "alpha-candidate-a-pre-cutover-v1",
                  status: "running",
                },
              ]
            : []
        );
      }
      throw new Error("restore_points_must_not_be_read");
    });
    const verify = vi.fn();
    const adapter = new CherryDatabaseCellAdapter({
      authToken: "token",
      projectId: "99",
      timeoutMs: 1000,
      region: "LT-Siauliai",
      plan: "B1-1-1gb-20s-shared",
      image: "ubuntu-24-04",
      storagePlanId: 500,
      sshKeyIds: [4],
      renderUserData: async () => "I2Nsb3VkLWNvbmZpZw==",
      databaseVerifier: { verify },
      actionPollAttempts: 2,
      actionPollIntervalMs: 0,
      sleep: async () => {},
      fetchImpl,
    });
    await expect(
      adapter.backup({
        cellId: "77",
        expectedNodeId: ACTION.nodeId,
        backupLabel: "alpha-candidate-a-pre-cutover-v1",
      })
    ).rejects.toThrow("cherry_database_cell_backup_timeout");
    expect(verify).not.toHaveBeenCalled();
  });
});
