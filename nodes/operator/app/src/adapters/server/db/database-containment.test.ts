// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it, vi } from "vitest";
import type {
  DatabaseContainmentAction,
  OperatorSecretsPlanePort,
} from "@/ports";
import { CherryDatabaseCellAdapter } from "../compute/cherry-database-cell.adapter";
import {
  CherryDatabaseSourceFenceAdapter,
  PinoLokiDatabaseContainmentAuditAdapter,
  PostgresAdminSqlAdapter,
} from "./database-containment-production.adapter";
import {
  DatabaseDsnRotationAdapter,
  DatabaseDsnRotationError,
} from "./database-dsn-rotation.adapter";
import {
  createPostgresDatabaseContainmentAdapter,
  type DatabaseContainmentAuditEvent,
  DatabaseContainmentConfigurationError,
  PostgresDatabaseContainmentAdapter,
} from "./postgres-database-containment.adapter";

const ACTION: DatabaseContainmentAction = {
  nodeId: "00000000-0000-4000-8000-000000000011",
  nodeSlug: "poly",
  environment: "candidate-a",
  incidentId: "incident-1",
  reason: "critical_io_pressure",
  actorId: "operator:test",
  desiredTier: "dedicated",
  budgetProfile: "poly-dedicated-v1",
};

describe("PostgresDatabaseContainmentAdapter", () => {
  it("rejects a non-Postgres privileged DSN", () => {
    expect(() => new PostgresAdminSqlAdapter("https://db.example")).toThrow(
      "database_control_dsn_invalid"
    );
  });

  it("writes structured audit and reads the latest transition from Loki", async () => {
    const info = vi.fn();
    const adapter = new PinoLokiDatabaseContainmentAuditAdapter(
      { info } as never,
      {
        queryRange: async () => [
          {
            ts: "1",
            line: JSON.stringify({
              ...ACTION,
              action: "contained",
              occurredAt: "2026-10-13T23:30:00.000Z",
            }),
          },
        ],
      },
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
        nodeSlug === "poly"
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
      adapter.isFenced({ ...ACTION, nodeSlug: "beacon" })
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
        fence: undefined,
        audit: undefined,
      } as never)
    ).toThrowError(DatabaseContainmentConfigurationError);
  });

  it("contains and readmits only the node roles with audited phase state", async () => {
    let canLogin = true;
    let sessions = 8;
    let fenced = false;
    const events: DatabaseContainmentAuditEvent[] = [];
    const sql = {
      async query<T extends Record<string, unknown>>(
        statement: string
      ): Promise<readonly T[]> {
        if (statement.startsWith("ALTER ROLE")) {
          canLogin = statement.endsWith(" LOGIN");
          return [];
        }
        if (statement.includes("pg_terminate_backend")) {
          sessions = 0;
          return [];
        }
        if (statement.includes("FROM pg_roles")) {
          return ["app_poly", "service_poly"].map((rolname) => ({
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
      fence: {
        isFenced: async () => fenced,
        setFenced: async ({ fenced: value }) => {
          fenced = value;
        },
      },
      audit: {
        append: async (event) => {
          events.push(event);
        },
        latest: async () => events.at(-1) ?? null,
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

    const open = await adapter.readmit(ACTION);
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
  });

  it("audits intent and partial failure without calling the firewall", async () => {
    const events: DatabaseContainmentAuditEvent[] = [];
    const setFenced = vi.fn();
    const adapter = new PostgresDatabaseContainmentAdapter({
      sql: {
        query: async () => {
          throw new Error("admin_sql_failed");
        },
      },
      fence: { isFenced: async () => false, setFenced },
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
    expect(setFenced).not.toHaveBeenCalled();
  });

  it("rejects automated readmission before changing roles", async () => {
    const query = vi.fn();
    const append = vi.fn();
    const adapter = new PostgresDatabaseContainmentAdapter({
      sql: { query },
      fence: { isFenced: async () => false, setFenced: vi.fn() },
      audit: { append, latest: async () => null },
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
      fence: { isFenced: async () => true, setFenced: vi.fn() },
      audit: { append: vi.fn(), latest: async () => null },
    });
    await expect(adapter.status(ACTION)).resolves.toMatchObject({
      rolesPresent: false,
      contained: false,
      phase: "recovering",
    });
  });
});

describe("DatabaseDsnRotationAdapter", () => {
  const target = {
    app: "postgresql://app_poly:a@10.0.0.2:5432/cogni_poly",
    service: "postgresql://service_poly:b@10.0.0.2:5432/cogni_poly",
  };
  const rollback = {
    app: "postgresql://app_poly:c@10.0.0.1:5432/cogni_poly",
    service: "postgresql://service_poly:d@10.0.0.1:5432/cogni_poly",
  };

  it("writes both DSNs atomically before sync and live verification", async () => {
    const calls: string[] = [];
    const writes: Readonly<Record<string, string>>[] = [];
    const secrets: OperatorSecretsPlanePort = {
      writeSecret: vi.fn(),
      writeSecrets: async ({ values }) => {
        calls.push("write");
        writes.push(values);
        return {
          written: true,
          version: 4,
          path: "cogni/candidate-a/poly",
          keys: Object.keys(values),
        };
      },
    };
    const adapter = new DatabaseDsnRotationAdapter({
      secrets,
      sync: {
        forceAndWait: async () => {
          calls.push("sync");
          return { receiptId: "eso-4" };
        },
      },
      verifier: {
        verify: async () => {
          calls.push("verify");
          return { endpointFingerprint: "db:dedicated:poly" };
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
      target,
      rollback,
    });
    expect(calls).toEqual(["write", "sync", "verify", "audit"]);
    expect(writes[0]).toEqual({
      DATABASE_URL: target.app,
      DATABASE_SERVICE_URL: target.service,
    });
    expect(result).toMatchObject({
      openBaoVersion: 4,
      syncReceiptId: "eso-4",
      targetCellId: "cell-7",
    });
  });

  it("atomically restores the preserved source when verification fails", async () => {
    const writes: Readonly<Record<string, string>>[] = [];
    const auditActions: string[] = [];
    let version = 0;
    const adapter = new DatabaseDsnRotationAdapter({
      secrets: {
        writeSecret: vi.fn(),
        writeSecrets: async ({ values }) => {
          writes.push(values);
          version += 1;
          return {
            written: true,
            version,
            path: "cogni/candidate-a/poly",
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
        target,
        rollback,
      })
    ).rejects.toBeInstanceOf(DatabaseDsnRotationError);
    expect(writes).toEqual([
      { DATABASE_URL: target.app, DATABASE_SERVICE_URL: target.service },
      {
        DATABASE_URL: rollback.app,
        DATABASE_SERVICE_URL: rollback.service,
      },
    ]);
    expect(auditActions).toEqual(["database_dsn_rollback"]);
  });
});

describe("CherryDatabaseCellAdapter", () => {
  it("creates a fixed volume before the provider VM and returns no credentials", async () => {
    const requests: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const path = String(url);
      requests.push(`${init?.method ?? "GET"} ${path}`);
      if (path.endsWith("/projects/99/servers") && !init?.method) {
        return new Response("[]", { status: 200 });
      }
      if (path.endsWith("/projects/99/storages")) {
        return Response.json({ id: 55 }, { status: 201 });
      }
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
      fetchImpl,
      now: () => new Date("2026-10-13T23:30:00.000Z"),
    });
    const cell = await adapter.provision({
      nodeId: ACTION.nodeId,
      nodeSlug: "poly",
      environment: "candidate-a",
      budgetProfile: "poly-dedicated-v1",
      idempotencyKey: "poly-candidate-a-v1",
      storageGiB: 50,
    });
    expect(requests[1]).toContain("/storages");
    expect(requests[2]).toContain("/servers");
    expect(cell).toMatchObject({
      cellId: "77",
      phase: "provisioning",
      endpoint: null,
      storage: { volumeId: "55", sizeGiB: 50 },
    });
    expect(cell).not.toHaveProperty("authToken");
  });
});
