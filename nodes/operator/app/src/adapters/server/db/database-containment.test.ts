// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it, vi } from "vitest";
import type {
  DatabaseContainmentAction,
  OperatorSecretsPlanePort,
} from "@/ports";
import { CherryDatabaseCellAdapter } from "../compute/cherry-database-cell.adapter";
import {
  DatabaseDsnRotationAdapter,
  DatabaseDsnRotationError,
} from "./database-dsn-rotation.adapter";
import {
  type DatabaseContainmentAuditEvent,
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
          return ["app_poly", "service_poly", "readonly_poly"].map(
            (rolname) => ({
              rolname,
              rolcanlogin: canLogin,
            })
          ) as unknown as readonly T[];
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
      rolesCanLogin: false,
      firewallFenced: true,
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
      "contained",
      "readmitted",
    ]);
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
      fetchImpl,
      now: () => new Date("2026-10-13T23:30:00.000Z"),
    });
    const cell = await adapter.provision({
      nodeId: ACTION.nodeId,
      nodeSlug: "poly",
      environment: "candidate-a",
      budgetProfile: "poly-dedicated-v1",
      idempotencyKey: "poly-candidate-a-v1",
      region: "LT-Siauliai",
      plan: "B1-1-1gb-20s-shared",
      image: "ubuntu-24-04",
      storageGiB: 50,
      sshKeyIds: [4],
      userData: "I2Nsb3VkLWNvbmZpZw==",
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
