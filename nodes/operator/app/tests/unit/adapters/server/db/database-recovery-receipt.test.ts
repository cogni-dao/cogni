// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it, vi } from "vitest";
import {
  HttpReliabilityRecoveryAdapter,
  PostgresDatabaseContainmentControlAdapter,
  PostgresDatabaseRecoveryProbeAdapter,
  PostgresDatabaseRecoveryReader,
  PostgresDatabaseRecoveryWatchdogAdapter,
  RecoveryLedgerDatabaseContainmentAdapter,
} from "@/adapters/server/db/database-containment-production.adapter";
import type {
  DatabaseContainmentAction,
  DatabaseRecoveryContainPort,
  DatabaseRecoveryIncident,
  DatabaseRecoveryLedgerReaderPort,
} from "@/ports";

const probeFactory = vi.hoisted(() => vi.fn());
vi.mock("postgres", () => ({ default: probeFactory }));

// Native cogni_control.receipt(contain_database_incident(...)): no LOGIN intent exists yet.
const containedReceipt = {
  nodeId: "11111111-1111-4111-8111-111111111111",
  nodeSlug: "operator",
  environment: "candidate-a",
  incidentId: "reliability.v1:candidate-a:operator:1",
  actorId: "system:reliability-controller.v1",
  targetBuildSha: "a".repeat(40),
  databaseSystemIdentifier: "7390012345678901234",
  databaseName: "cogni_operator",
  appRole: "app_operator",
  serviceRole: "service_operator",
  state: "contained",
  reason: "critical_io_pressure",
  containedAt: "2026-10-14T21:00:00+00:00",
  startedAt: null,
  deadlineAt: null,
  verifiedAt: null,
};
const readerFor = (receipt: unknown) =>
  new PostgresDatabaseRecoveryReader({
    query: async <T extends Record<string, unknown>>() =>
      [{ incident: receipt }] as unknown as readonly T[],
  });

describe("native durable incident receipts", () => {
  it("requires a completed native watchdog enforcement transaction and bounded heartbeat", async () => {
    const transition = {
      ...containedReceipt,
      state: "recontained",
      transitionApplied: true,
    };
    const receipt = {
      observedAt: containedReceipt.containedAt,
      heartbeatExpiresAt: "2026-10-14T21:00:15+00:00",
      transitions: [transition],
    };
    const query = vi.fn().mockResolvedValue([{ receipt }]);
    const watchdog = new PostgresDatabaseRecoveryWatchdogAdapter({ query });
    await expect(
      watchdog.tick({
        environment: "candidate-a",
        ownerId: containedReceipt.nodeId,
      })
    ).resolves.toMatchObject({
      transitions: [
        expect.objectContaining({
          state: "recontained",
          transitionApplied: true,
        }),
      ],
    });
    expect(query).toHaveBeenCalledWith(
      "SELECT public.database_recovery_watchdog_tick($1::text,$2::text) AS receipt",
      ["candidate-a", containedReceipt.nodeId]
    );
    query.mockResolvedValue([
      {
        receipt: {
          ...receipt,
          heartbeatExpiresAt: "2026-10-14T21:01:00+00:00",
        },
      },
    ]);
    await expect(
      watchdog.tick({
        environment: "candidate-a",
        ownerId: containedReceipt.nodeId,
      })
    ).rejects.toThrow("database_recovery_watchdog_receipt_invalid");
    query.mockResolvedValue([
      {
        receipt: {
          ...receipt,
          transitions: [{ ...transition, environment: "production" }],
        },
      },
    ]);
    await expect(
      watchdog.tick({
        environment: "candidate-a",
        ownerId: containedReceipt.nodeId,
      })
    ).rejects.toThrow("database_recovery_watchdog_receipt_invalid");
  });

  it("rejects recovery bodies at another SHA even when HTTP and labels claim success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "healthy",
          buildSha: "b".repeat(40),
          databaseSystemIdentifier: "123456",
          incidentId: containedReceipt.incidentId,
          proofClass: "recovery",
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const reader = new HttpReliabilityRecoveryAdapter({
        baseUrl: "http://private.invalid",
        bearerToken: "private-test-token",
      });
      await expect(
        reader.read({
          nodeId: containedReceipt.nodeId,
          nodeSlug: "operator",
          environment: "candidate-a",
          expectedBuildSha: "a".repeat(40),
          proofClass: "recovery",
        })
      ).rejects.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("reads initial NOLOGIN containment with nullable LOGIN timestamps", async () => {
    const reader = readerFor(containedReceipt);
    await expect(reader.current(containedReceipt)).resolves.toMatchObject({
      state: "contained",
      containedAt: new Date(containedReceipt.containedAt).toISOString(),
      startedAt: null,
      deadlineAt: null,
    });
    await expect(reader.listPending(containedReceipt)).resolves.toEqual([]);
  });

  it("rejects recovering state without an absolute ten-minute intent", async () => {
    for (const receipt of [
      { ...containedReceipt, state: "recovering" },
      {
        ...containedReceipt,
        state: "recovering",
        startedAt: containedReceipt.containedAt,
        deadlineAt: "2026-10-14T21:11:00+00:00",
      },
    ])
      await expect(
        readerFor(receipt).current(containedReceipt)
      ).rejects.toThrow();
  });

  it("enumerates persisted LOGIN intent while keeping terminal proof mandatory", async () => {
    const recovery = {
      ...containedReceipt,
      state: "recovering",
      startedAt: containedReceipt.containedAt,
      deadlineAt: "2026-10-14T21:10:00+00:00",
    };
    await expect(
      readerFor(recovery).listPending(containedReceipt)
    ).resolves.toHaveLength(1);
    await expect(
      readerFor({ ...recovery, state: "readmitted" }).current(containedReceipt)
    ).rejects.toThrow();
  });
});

describe("atomic containment publication", () => {
  const action: DatabaseContainmentAction = {
    nodeId: containedReceipt.nodeId,
    nodeSlug: "operator",
    environment: "candidate-a",
    incidentId: containedReceipt.incidentId,
    actorId: containedReceipt.actorId,
    desiredTier: "shared",
    budgetProfile: "shared-default-v1",
    reason: "critical_io_pressure",
  };

  it("publishes one event chain across concurrent controller owners", async () => {
    const events: string[] = [];
    let ownerAssigned = false;
    const ledger: DatabaseRecoveryContainPort &
      DatabaseRecoveryLedgerReaderPort = {
      current: async () => containedReceipt as DatabaseRecoveryIncident,
      listPending: async () => [],
      contain: async () => {
        const transitionApplied = !ownerAssigned;
        ownerAssigned = true;
        await Promise.resolve();
        return {
          ...containedReceipt,
          state: "contained" as const,
          environment: "candidate-a" as const,
          transitionApplied,
        };
      },
    };
    const deps = {
      ledger,
      targetBuildShaFor: () => containedReceipt.targetBuildSha,
      audit: {
        append: async (event: { action: string }) => {
          events.push(event.action);
        },
      },
      probe: {
        observe: async () => ({
          database: "cogni_operator",
          role: "probe_operator",
          systemTenantExists: true,
          serverAddress: "192.0.2.1",
          serverPort: 5432,
          systemIdentifier: containedReceipt.databaseSystemIdentifier,
          appRolesCanLogin: false,
          runtimeRolesPresent: true,
          runtimeRolesNoLogin: true,
          activeRuntimeSessions: 0,
          observedAt: containedReceipt.containedAt,
          probeRoleIsolated: true,
        }),
      },
    };
    const results = await Promise.all([
      new RecoveryLedgerDatabaseContainmentAdapter(deps).contain(action),
      new RecoveryLedgerDatabaseContainmentAdapter(deps).contain(action),
    ]);
    expect(
      results.every(
        (result) => result.contained && result.incidentId === action.incidentId
      )
    ).toBe(true);
    expect(events).toEqual(["containment_requested", "contained"]);
  });

  it("requires the native transition owner marker before publishing", async () => {
    const sql = {
      query: async <T extends Record<string, unknown>>() =>
        [{ incident: containedReceipt }] as unknown as readonly T[],
    };
    await expect(
      new PostgresDatabaseContainmentControlAdapter(sql).contain({
        ...action,
        targetBuildSha: containedReceipt.targetBuildSha,
        databaseSystemIdentifier: containedReceipt.databaseSystemIdentifier,
        databaseName: containedReceipt.databaseName,
      })
    ).rejects.toThrow();
  });
});

describe("isolated probe session ownership", () => {
  const binding = {
    nodeId: containedReceipt.nodeId,
    nodeSlug: "operator",
    environment: "candidate-a",
    databaseName: "cogni_operator",
    probeRole: "probe_operator",
    systemIdentifier: containedReceipt.databaseSystemIdentifier,
    substrateHost: "a".repeat(32),
    dsn: "postgresql://probe_operator:fixture@candidate-a.vm.example.invalid:5432/cogni_operator",
  };
  const input = {
    nodeId: binding.nodeId,
    nodeSlug: binding.nodeSlug,
    environment: "candidate-a" as const,
  };
  const observation = {
    database: binding.databaseName,
    role: binding.probeRole,
    systemTenantExists: true,
    serverAddress: "192.0.2.1",
    serverPort: 5432,
    systemIdentifier: binding.systemIdentifier,
    appRolesCanLogin: false,
    runtimeRolesPresent: true,
    runtimeRolesNoLogin: true,
    activeRuntimeSessions: 0,
    observedAt: containedReceipt.containedAt,
    probeRoleIsolated: true,
  };

  it("serializes concurrent status/core observations and closes each role slot before the next", async () => {
    let active = 0;
    const closes: number[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    probeFactory.mockReset().mockImplementation(() => {
      const index = probeFactory.mock.calls.length;
      active += 1;
      expect(active).toBe(1);
      return {
        unsafe: async () => {
          if (index === 1) await gate;
          return [{ observation }];
        },
        end: async () => {
          active -= 1;
          closes.push(index);
        },
      };
    });
    const adapter = new PostgresDatabaseRecoveryProbeAdapter([binding]);
    const first = adapter.observe(input);
    const second = adapter.observe(input);
    await vi.waitFor(() => expect(probeFactory).toHaveBeenCalledTimes(1));
    release?.();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(closes).toEqual([1, 2]);
    expect(active).toBe(0);
  });

  it("releases a failed sample before accepting the next queued observation", async () => {
    const close = vi.fn(async () => undefined);
    probeFactory
      .mockReset()
      .mockReturnValueOnce({
        unsafe: async () => {
          throw new Error("probe unavailable");
        },
        end: close,
      })
      .mockReturnValueOnce({
        unsafe: async () => [{ observation }],
        end: close,
      });
    const adapter = new PostgresDatabaseRecoveryProbeAdapter([binding]);
    const first = adapter.observe(input);
    const next = adapter.observe(input);
    await expect(first).rejects.toThrow("probe unavailable");
    await expect(next).resolves.toMatchObject({ runtimeRolesNoLogin: true });
    expect(close).toHaveBeenCalledTimes(2);
  });
});
