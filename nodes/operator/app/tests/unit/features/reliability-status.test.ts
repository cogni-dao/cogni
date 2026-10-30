// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import {
  RELIABILITY_POLICY_V1,
  reliabilityStatusV1Schema,
} from "@cogni/node-contracts";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  evaluateReliabilityPolicy,
  hasHealthyReadmissionWindow,
  hasHealthyScopedRecoveryWindow,
  isReadmissionRuntimeReady,
  isReliabilitySweepReady,
  reconcileReliabilityContainment,
  runReliabilitySweep,
  serveEvidenceTtlMs,
  verifyCurrentDatabaseRecovery,
} from "@/features/nodes/reliability-status";
import type { DatabaseContainmentPort, MetricsQueryPort } from "@/ports";

const routeMocks = vi.hoisted(() => ({
  queryReliabilitySnapshot: vi.fn(),
  resolvePlacement: vi.fn(),
  readmit: vi.fn(),
  readStatus: vi.fn(),
  getDeployState: vi.fn(),
  humanSession: vi.fn(),
  localControl: vi.fn(),
}));
const ROUTE_NODE_ID = "123e4567-e89b-12d3-a456-426614174001";
const ROUTE_BUILD_SHA = "0123456789abcdef0123456789abcdef01234567";
const ROUTE_CATALOG_SHA = "89abcdef0123456789abcdef0123456789abcdef";

vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(async () => ({ id: "user-1" })),
}));
vi.mock("@/lib/auth/server", () => ({
  getServerSessionUser: (...args: unknown[]) =>
    routeMocks.humanSession(...args),
}));
vi.mock("@/app/_lib/node-rbac", () => ({
  resolveNodeAndAuthorize: vi.fn(async () => ({
    ok: true,
    node: {
      nodeId: "123e4567-e89b-12d3-a456-426614174001",
      slug: "poly",
    },
  })),
}));
vi.mock("@/bootstrap/container", () => ({
  resolveLocalReliabilityControl: () => routeMocks.localControl(),
  getContainer: () => ({
    reliabilityStatusReader: { read: routeMocks.readStatus },
    deployCapability: { getDeployState: routeMocks.getDeployState },
    metricsQuery: {
      queryReliabilitySnapshot: routeMocks.queryReliabilitySnapshot,
    },
    reliabilityReadmit: { readmit: routeMocks.readmit },
  }),
  resolveDatabasePlacementResolver: () => ({
    resolve: routeMocks.resolvePlacement,
  }),
  getRequestLoggingDependencies: () => {
    const log = {
      child: () => log,
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
    };
    return {
      log,
      clock: { now: () => new Date().toISOString() },
      config: { unhandledErrorPolicy: "rethrow" },
    };
  },
}));

import {
  GET as GET_HEALTH,
  POST as POST_READMIT,
} from "@/app/api/v1/nodes/[id]/observability/health/route";

const healthy = {
  buildSha: "0123456789abcdef0123456789abcdef01234567",
  database: {
    nodeId: "11111111-1111-4111-8111-111111111111",
    nodeSlug: "operator",
    environment: "candidate-a" as const,
    desiredTier: "shared" as const,
    budgetProfile: "shared-small",
    contained: false,
    phase: "open" as const,
    activeSessions: 0,
    rolesCanLogin: true,
    firewallFenced: false,
    cell: null,
    observedAt: "2026-10-13T20:00:00.000Z",
    lastTransitionAt: null,
    incidentId: null,
    reason: null,
  },
  regionalReadiness: [
    {
      region: "Frankfurt",
      healthy: true,
      observedAt: new Date().toISOString(),
    },
    {
      region: "Ohio",
      healthy: true,
      observedAt: new Date().toISOString(),
    },
  ],
  utilization: {
    evidenceScope: "environment-shared" as const,
    ioPressurePct: 2,
    connectionPct: 20,
    memoryHeadroomPct: 70,
    diskHeadroomPct: 70,
    databaseShare5m: {
      backendsPct: null,
      physicalReadsPct: null,
      tempBytesPct: null,
    },
  },
  incidentId: null,
};

describe("ReliabilityStatusV1 policy", () => {
  it("keeps readiness false through partial, failed, and stale sweeps", () => {
    const targets = new Set(["candidate-a/operator", "candidate-a/red"]);
    const complete = new Set(targets);
    const partial = new Set(["candidate-a/operator"]);
    const nowMs = Date.now();
    expect(
      isReliabilitySweepReady({
        nowMs,
        lastCompleteSweepAt: null,
        targetKeys: targets,
        statusKeys: partial,
      })
    ).toBe(false);
    expect(
      isReliabilitySweepReady({
        nowMs,
        lastCompleteSweepAt: nowMs,
        targetKeys: targets,
        statusKeys: complete,
      })
    ).toBe(true);
    expect(
      isReliabilitySweepReady({
        nowMs,
        lastCompleteSweepAt: null,
        targetKeys: targets,
        statusKeys: complete,
      })
    ).toBe(false);
    expect(
      isReliabilitySweepReady({
        nowMs,
        lastCompleteSweepAt: nowMs - 120_001,
        targetKeys: targets,
        statusKeys: complete,
      })
    ).toBe(false);
  });

  it("rejects future-dated readmission samples", () => {
    const nowMs = Date.now();
    const nowSeconds = Math.floor(nowMs / 1000);
    const samplesEndingAt = (endSeconds: number) =>
      Array.from({ length: 5 }, (_, index) => [
        endSeconds - (4 - index) * 60,
        "1",
      ]) as [number, string][];
    expect(
      hasHealthyReadmissionWindow({
        nowMs,
        series: [
          {
            metric: { probe: "Frankfurt" },
            values: samplesEndingAt(nowSeconds),
          },
          {
            metric: { region: "Ohio" },
            values: samplesEndingAt(nowSeconds),
          },
        ],
      })
    ).toBe(true);
    expect(
      hasHealthyReadmissionWindow({
        nowMs,
        series: [
          {
            metric: { probe: "Frankfurt" },
            values: samplesEndingAt(nowSeconds),
          },
          {
            metric: { region: "Ohio" },
            values: samplesEndingAt(nowSeconds + 16),
          },
        ],
      })
    ).toBe(false);
  });

  it("requires five complete minutes in exactly two regions at the same SHA and database", () => {
    const nowMs = Date.now();
    const nowSeconds = Math.floor(nowMs / 1000);
    const input = {
      nowMs,
      since: new Date((nowSeconds - 300) * 1000).toISOString(),
      targetBuildSha: "a".repeat(40),
      databaseSystemIdentifier: "123456",
      proofClass: "recovery" as const,
      series: ["Frankfurt", "Ohio"].map((probe) => ({
        metric: {
          probe,
          target_build_sha: "a".repeat(40),
          database_system_identifier: "123456",
          proof_class: "recovery",
        },
        values: Array.from(
          { length: 5 },
          (_, i) => [nowSeconds - (4 - i) * 60, "1"] as [number, string]
        ),
      })),
    };
    expect(hasHealthyScopedRecoveryWindow(input)).toBe(true);
    expect(
      hasHealthyScopedRecoveryWindow({
        ...input,
        since: new Date((nowSeconds - 299) * 1000).toISOString(),
      })
    ).toBe(false);
    expect(
      hasHealthyScopedRecoveryWindow({
        ...input,
        targetBuildSha: "b".repeat(40),
      })
    ).toBe(false);
    expect(
      hasHealthyScopedRecoveryWindow({
        ...input,
        databaseSystemIdentifier: "999",
      })
    ).toBe(false);
    expect(
      hasHealthyScopedRecoveryWindow({
        ...input,
        proofClass: "recovery-product",
      })
    ).toBe(false);
    expect(
      hasHealthyScopedRecoveryWindow({
        ...input,
        series: [...input.series, ...input.series],
      })
    ).toBe(false);
  });

  it("keeps the readmitter unready when sweep status is unreachable", async () => {
    const target = {
      nodeId: ROUTE_NODE_ID,
      slug: "operator",
      environment: "candidate-a" as const,
      desiredTier: "shared" as const,
      budgetProfile: "shared-default-v1",
      sourceSha: ROUTE_BUILD_SHA,
    };
    const status = { status: vi.fn(async () => undefined as never) };
    await expect(
      isReadmissionRuntimeReady({
        readmissionConfigured: true,
        targets: [target],
        status,
      })
    ).resolves.toBe(true);
    status.status.mockRejectedValueOnce(new Error("sweep unavailable"));
    await expect(
      isReadmissionRuntimeReady({
        readmissionConfigured: true,
        targets: [target],
        status,
      })
    ).resolves.toBe(false);
  });

  it("fences failed product behavior before considering its five-minute window", async () => {
    const incident = {
      nodeId: ROUTE_NODE_ID,
      environment: "candidate-a",
      incidentId: "reliability.v1:test",
      targetBuildSha: ROUTE_BUILD_SHA,
      databaseSystemIdentifier: "12345",
    } as import("@/ports").DatabaseRecoveryIncident;
    const recontain = vi
      .fn()
      .mockResolvedValue({ transitionApplied: true, state: "recontained" });
    const complete = vi.fn();
    const window = vi.fn();
    const ledger = {
      recontain,
      complete,
      current: vi.fn(),
      listPending: vi.fn(),
    };
    await expect(
      verifyCurrentDatabaseRecovery({
        incident,
        ledger,
        proveCurrentProduct: async () => false,
        proveWindow: window,
      })
    ).resolves.toMatchObject({ state: "recontained" });
    expect(recontain).toHaveBeenCalledWith(
      expect.objectContaining({
        incidentId: incident.incidentId,
        reason: "recovery_product_evidence_unavailable",
      })
    );
    expect(window).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("waits on an incomplete window while current product behavior remains healthy", async () => {
    const incident = {
      nodeId: ROUTE_NODE_ID,
      environment: "candidate-a",
      incidentId: "reliability.v1:test",
      targetBuildSha: ROUTE_BUILD_SHA,
      databaseSystemIdentifier: "12345",
    } as import("@/ports").DatabaseRecoveryIncident;
    const ledger = {
      recontain: vi.fn(),
      complete: vi.fn(),
      current: vi.fn(),
      listPending: vi.fn(),
    };
    await expect(
      verifyCurrentDatabaseRecovery({
        incident,
        ledger,
        proveCurrentProduct: async () => true,
        proveWindow: async () => false,
      })
    ).resolves.toBeNull();
    expect(ledger.recontain).not.toHaveBeenCalled();
    expect(ledger.complete).not.toHaveBeenCalled();
  });

  it("fails closed when any required signal is missing", () => {
    expect(
      evaluateReliabilityPolicy({
        ...healthy,
        utilization: { ...healthy.utilization, ioPressurePct: null },
      })
    ).toEqual({
      state: "unknown",
      reason: "required reliability evidence is missing",
    });
  });

  it("uses the reviewed warning and critical thresholds", () => {
    expect(
      evaluateReliabilityPolicy({
        ...healthy,
        utilization: { ...healthy.utilization, ioPressurePct: 10 },
      })
    ).toEqual({ state: "warning", reason: "I/O pressure warning" });

    expect(
      evaluateReliabilityPolicy({
        ...healthy,
        utilization: { ...healthy.utilization, connectionPct: 75 },
      })
    ).toEqual({
      state: "warning",
      reason: "database connections critical",
    });
  });

  it("makes audited containment authoritative", () => {
    expect(
      evaluateReliabilityPolicy({
        ...healthy,
        database: {
          ...healthy.database,
          contained: true,
          phase: "contained" as const,
          rolesCanLogin: false,
          firewallFenced: true,
          reason: "operator_action" as const,
        },
      })
    ).toEqual({ state: "contained", reason: "operator_action" });
  });

  it("grades readiness unknown once the last probe sample outlives its cadence bound (bug.5527)", () => {
    const now = Date.now();
    const at = (ageMs: number) => ({
      ...healthy,
      observedAt: new Date(now).toISOString(),
      regionalReadiness: healthy.regionalReadiness.map((sample) => ({
        ...sample,
        observedAt: new Date(now - ageMs).toISOString(),
      })),
    });
    const unknown = {
      state: "unknown",
      reason: "required reliability evidence is missing",
    };
    const nonProdTtl = serveEvidenceTtlMs("candidate-a");
    expect(nonProdTtl).toBe(
      Math.max(
        RELIABILITY_POLICY_V1.evidenceTtlMs,
        2 * RELIABILITY_POLICY_V1.serveProbes["candidate-a"].frequencyMs
      )
    );
    expect(serveEvidenceTtlMs("production")).toBe(
      RELIABILITY_POLICY_V1.evidenceTtlMs
    );
    // One non-prod probe interval old is fresh; past one missed run is stale.
    const interval =
      RELIABILITY_POLICY_V1.serveProbes["candidate-a"].frequencyMs;
    expect(evaluateReliabilityPolicy(at(interval))).toEqual({
      state: "healthy",
      reason: null,
    });
    expect(evaluateReliabilityPolicy(at(nonProdTtl + 1_000))).toEqual(unknown);
    // The same sample age is stale for production's 60s cadence.
    expect(
      evaluateReliabilityPolicy({ ...at(interval), environment: "production" })
    ).toEqual(unknown);
  });

  it("returns healthy only with two healthy regions and full headroom", () => {
    expect(evaluateReliabilityPolicy(healthy)).toEqual({
      state: "healthy",
      reason: null,
    });
  });

  it("rejects short SHAs and duplicate, unknown, or stale readiness regions", () => {
    expect(
      reliabilityStatusV1Schema.safeParse({
        version: "reliability-status.v1",
        nodeId: healthy.database.nodeId,
        slug: healthy.database.nodeSlug,
        environment: healthy.database.environment,
        buildSha: "1234567",
        databaseTier: "shared",
        budgetProfile: "shared-small",
        state: "unknown",
        regionalReadiness: [],
        utilization: healthy.utilization,
        incidentReason: "missing",
        observedAt: new Date().toISOString(),
        lastTransitionAt: null,
        evidenceQueryRefs: [],
      }).success
    ).toBe(false);

    for (const regionalReadiness of [
      [healthy.regionalReadiness[0], healthy.regionalReadiness[0]],
      [
        healthy.regionalReadiness[0],
        { ...healthy.regionalReadiness[1], region: "unknown" },
      ],
      healthy.regionalReadiness.map((sample) => ({
        ...sample,
        observedAt: "2026-01-01T00:00:00.000Z",
      })),
    ]) {
      expect(
        evaluateReliabilityPolicy({ ...healthy, regionalReadiness })
      ).toEqual({
        state: "unknown",
        reason: "required reliability evidence is missing",
      });
    }
  });

  it("reports attributed critical pressure without changing role admission", async () => {
    const actions: Parameters<DatabaseContainmentPort["contain"]>[0][] = [];
    const containment: DatabaseContainmentPort = {
      status: async () => healthy.database,
      contain: async (action) => {
        actions.push(action);
        return {
          ...healthy.database,
          contained: true,
          phase: "contained",
          rolesCanLogin: false,
          firewallFenced: true,
          lastTransitionAt: "2026-10-13T20:00:00.000Z",
          incidentId: action.incidentId,
          reason: action.reason,
        };
      },
      readmit: async () => healthy.database,
    };
    const metrics = {
      queryReliabilitySnapshot: async () => ({
        regionalReadiness: [
          {
            region: "Frankfurt",
            healthy: true,
            observedAt: new Date().toISOString(),
          },
          {
            region: "Ohio",
            healthy: true,
            observedAt: new Date().toISOString(),
          },
        ],
        evidenceScope: "node",
        ioPressurePct: 20,
        connectionPct: 20,
        memoryHeadroomPct: 70,
        diskHeadroomPct: 70,
        databaseShare5m: {
          backendsPct: 20,
          physicalReadsPct: 41,
          tempBytesPct: 5,
        },
        evidenceQueryRefs: ["reliability.v1:test"],
      }),
    } as MetricsQueryPort;

    const status = await reconcileReliabilityContainment(
      {
        nodeId: healthy.database.nodeId,
        slug: healthy.database.nodeSlug,
        environment: healthy.database.environment,
        buildSha: healthy.buildSha,
        sourceSha: healthy.buildSha,
        desiredTier: healthy.database.desiredTier,
        budgetProfile: healthy.database.budgetProfile,
        incidentId: "replay-1",
      },
      { metrics, containment }
    );

    expect(status.state).toBe("warning");
    expect(status.incidentReason).toBe("I/O pressure critical");
    expect(actions).toEqual([]);
  });

  it("pages without mutation when shared-environment evidence is critical", async () => {
    const actions: Parameters<DatabaseContainmentPort["contain"]>[0][] = [];
    const containment: DatabaseContainmentPort = {
      status: async () => healthy.database,
      contain: async (action) => {
        actions.push(action);
        return healthy.database;
      },
      readmit: async () => healthy.database,
    };
    const metrics = {
      queryReliabilitySnapshot: async () => ({
        regionalReadiness: [
          {
            region: "Frankfurt",
            healthy: true,
            observedAt: new Date().toISOString(),
          },
          {
            region: "Ohio",
            healthy: true,
            observedAt: new Date().toISOString(),
          },
        ],
        evidenceScope: "environment-shared",
        ioPressurePct: 20,
        connectionPct: 20,
        memoryHeadroomPct: 70,
        diskHeadroomPct: 70,
        databaseShare5m: {
          backendsPct: null,
          physicalReadsPct: null,
          tempBytesPct: null,
        },
        evidenceQueryRefs: ["reliability.v1:test"],
      }),
    } as MetricsQueryPort;

    const status = await reconcileReliabilityContainment(
      {
        nodeId: healthy.database.nodeId,
        slug: healthy.database.nodeSlug,
        environment: healthy.database.environment,
        buildSha: healthy.buildSha,
        sourceSha: healthy.buildSha,
        desiredTier: healthy.database.desiredTier,
        budgetProfile: healthy.database.budgetProfile,
        incidentId: "replay-env-critical",
      },
      { metrics, containment }
    );

    expect(status).toMatchObject({
      state: "warning",
      incidentReason: "I/O pressure critical",
      utilization: { evidenceScope: "environment-shared" },
    });
    expect(actions).toEqual([]);
  });

  it("does not contain node-attributed critical pressure below 40% share", async () => {
    const actions: Parameters<DatabaseContainmentPort["contain"]>[0][] = [];
    const containment: DatabaseContainmentPort = {
      status: async () => healthy.database,
      contain: async (action) => {
        actions.push(action);
        return healthy.database;
      },
      readmit: async () => healthy.database,
    };
    const metrics = {
      queryReliabilitySnapshot: async () => ({
        regionalReadiness: [
          {
            region: "Frankfurt",
            healthy: true,
            observedAt: new Date().toISOString(),
          },
          {
            region: "Ohio",
            healthy: true,
            observedAt: new Date().toISOString(),
          },
        ],
        evidenceScope: "node",
        ioPressurePct: 20,
        connectionPct: 20,
        memoryHeadroomPct: 70,
        diskHeadroomPct: 70,
        databaseShare5m: {
          backendsPct: 39.9,
          physicalReadsPct: 39.9,
          tempBytesPct: 39.9,
        },
        evidenceQueryRefs: ["reliability.v1:test"],
      }),
    } as MetricsQueryPort;

    const status = await reconcileReliabilityContainment(
      {
        nodeId: healthy.database.nodeId,
        slug: healthy.database.nodeSlug,
        environment: healthy.database.environment,
        buildSha: healthy.buildSha,
        sourceSha: healthy.buildSha,
        desiredTier: healthy.database.desiredTier,
        budgetProfile: healthy.database.budgetProfile,
        incidentId: "replay-below-threshold",
      },
      { metrics, containment }
    );

    expect(status.state).toBe("warning");
    expect(actions).toEqual([]);
  });

  it("does not cross-attribute backend share to I/O pressure", async () => {
    const actions: Parameters<DatabaseContainmentPort["contain"]>[0][] = [];
    const containment: DatabaseContainmentPort = {
      status: async () => healthy.database,
      contain: async (action) => {
        actions.push(action);
        return healthy.database;
      },
      readmit: async () => healthy.database,
    };
    const metrics = {
      queryReliabilitySnapshot: async () => ({
        regionalReadiness: healthy.regionalReadiness,
        evidenceScope: "node",
        ioPressurePct: 20,
        connectionPct: 20,
        memoryHeadroomPct: 70,
        diskHeadroomPct: 70,
        databaseShare5m: {
          backendsPct: 90,
          physicalReadsPct: 10,
          tempBytesPct: 10,
        },
        evidenceQueryRefs: ["reliability.v1:test"],
      }),
    } as MetricsQueryPort;

    const status = await reconcileReliabilityContainment(
      {
        nodeId: healthy.database.nodeId,
        slug: healthy.database.nodeSlug,
        environment: healthy.database.environment,
        buildSha: healthy.buildSha,
        sourceSha: healthy.buildSha,
        desiredTier: "shared",
        budgetProfile: healthy.database.budgetProfile,
        incidentId: "crossed-signal",
      },
      { metrics, containment }
    );

    expect(status.state).toBe("warning");
    expect(actions).toEqual([]);
  });

  it("fails dedicated targets closed without dedicated cell telemetry", async () => {
    const actions: Parameters<DatabaseContainmentPort["contain"]>[0][] = [];
    const containment: DatabaseContainmentPort = {
      status: async () => ({
        ...healthy.database,
        desiredTier: "dedicated",
        budgetProfile: "poly-dedicated-v1",
      }),
      contain: async (action) => {
        actions.push(action);
        return healthy.database;
      },
      readmit: async () => healthy.database,
    };
    const metrics = {
      queryReliabilitySnapshot: async () => ({
        regionalReadiness: [
          {
            region: "Frankfurt",
            healthy: true,
            observedAt: new Date().toISOString(),
          },
          {
            region: "Ohio",
            healthy: true,
            observedAt: new Date().toISOString(),
          },
        ],
        evidenceScope: "node",
        ioPressurePct: 20,
        connectionPct: 20,
        memoryHeadroomPct: 70,
        diskHeadroomPct: 70,
        databaseShare5m: {
          backendsPct: 80,
          physicalReadsPct: 80,
          tempBytesPct: 80,
        },
        evidenceQueryRefs: ["reliability.v1:test"],
      }),
    } as MetricsQueryPort;

    const status = await reconcileReliabilityContainment(
      {
        nodeId: healthy.database.nodeId,
        slug: "poly",
        environment: healthy.database.environment,
        buildSha: healthy.buildSha,
        sourceSha: healthy.buildSha,
        desiredTier: "dedicated",
        budgetProfile: "poly-dedicated-v1",
        incidentId: "replay-dedicated",
      },
      { metrics, containment }
    );

    expect(status).toMatchObject({
      state: "unknown",
      incidentReason:
        "dedicated database cell telemetry is not node-attributed",
    });
    expect(actions).toEqual([]);
  });

  it("continues a bounded sweep when one target fails", async () => {
    const targets = [
      {
        nodeId: "11111111-1111-4111-8111-111111111111",
        slug: "broken",
        environment: "candidate-a" as const,
        desiredTier: "shared" as const,
        budgetProfile: "shared-small",
        sourceSha: healthy.buildSha,
      },
      {
        nodeId: healthy.database.nodeId,
        slug: healthy.database.nodeSlug,
        environment: "candidate-a" as const,
        desiredTier: "shared" as const,
        budgetProfile: "shared-small",
        sourceSha: healthy.buildSha,
      },
    ];
    const containment: DatabaseContainmentPort = {
      status: async (input) => {
        if (input.nodeSlug === "broken") throw new Error("admin unavailable");
        return healthy.database;
      },
      contain: async () => healthy.database,
      readmit: async () => healthy.database,
    };
    const metrics = {
      queryReliabilitySnapshot: async () => ({
        regionalReadiness: [
          {
            region: "Frankfurt",
            healthy: true,
            observedAt: new Date().toISOString(),
          },
          {
            region: "Ohio",
            healthy: true,
            observedAt: new Date().toISOString(),
          },
        ],
        evidenceScope: "environment-shared",
        ioPressurePct: 2,
        connectionPct: 20,
        memoryHeadroomPct: 70,
        diskHeadroomPct: 70,
        databaseShare5m: {
          backendsPct: null,
          physicalReadsPct: null,
          tempBytesPct: null,
        },
        evidenceQueryRefs: ["reliability.v1:test"],
      }),
    } as MetricsQueryPort;

    const results = await runReliabilitySweep(targets, {
      containment,
      metrics,
      buildShaFor: async () => healthy.buildSha,
      incidentIdFor: (target) => `minute:${target.slug}`,
    });

    expect(results).toEqual([
      expect.objectContaining({ status: null, error: "admin unavailable" }),
      expect.objectContaining({
        error: null,
        status: expect.objectContaining({ state: "healthy" }),
      }),
    ]);
  });
});

describe("reliability HTTP boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeMocks.humanSession.mockResolvedValue({ id: "user-1" });
    routeMocks.localControl.mockReturnValue({
      nodeId: "00000000-0000-4000-8000-000000000001",
      slug: "controller",
      buildSha: ROUTE_CATALOG_SHA,
    });
    process.env.APP_BUILD_SHA = ROUTE_CATALOG_SHA;
    process.env.DEPLOY_ENVIRONMENT = "candidate-a";
    routeMocks.resolvePlacement.mockResolvedValue({
      nodeId: ROUTE_NODE_ID,
      desiredTier: "dedicated",
      budgetProfile: "poly-dedicated-v1",
    });
    routeMocks.queryReliabilitySnapshot.mockRejectedValue(
      new Error("mimir unavailable")
    );
    routeMocks.getDeployState.mockResolvedValue({ buildSha: ROUTE_BUILD_SHA });
    routeMocks.readmit.mockResolvedValue({
      phase: "open",
      incidentId: "audit-incident",
      lastTransitionAt: new Date().toISOString(),
    });
    routeMocks.readStatus.mockRejectedValue(new Error("actuator unavailable"));
  });

  it("returns 200 unknown and resolves catalog at parent SHA on metrics failure", async () => {
    const response = await GET_HEALTH(
      new NextRequest(
        "https://operator.example/api/v1/nodes/poly/observability/health?env=candidate-a"
      ),
      { params: Promise.resolve({ id: ROUTE_NODE_ID }) }
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      state: "unknown",
      buildSha: ROUTE_BUILD_SHA,
      utilization: {
        evidenceScope: "environment-shared",
        databaseShare5m: {
          backendsPct: null,
          physicalReadsPct: null,
          tempBytesPct: null,
        },
      },
    });
    expect(routeMocks.resolvePlacement).toHaveBeenCalledWith({
      nodeSlug: "poly",
      environment: "candidate-a",
      sourceRef: ROUTE_CATALOG_SHA,
    });
  });

  it("binds readmission actor to session and rejects cross-environment reads", async () => {
    const rejected = await GET_HEALTH(
      new NextRequest(
        "https://operator.example/api/v1/nodes/poly/observability/health?env=production"
      ),
      { params: Promise.resolve({ id: ROUTE_NODE_ID }) }
    );
    expect(rejected.status).toBe(400);

    routeMocks.readStatus.mockResolvedValue({
      ...healthy,
      nodeId: ROUTE_NODE_ID,
      slug: "poly",
      environment: "candidate-a",
      state: "contained",
      incidentId: "reliability.v1:candidate-a:poly:123",
    });

    const response = await POST_READMIT(
      new NextRequest(
        "https://operator.example/api/v1/nodes/poly/observability/health",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ env: "candidate-a", actorId: "system:spoof" }),
        }
      ),
      { params: Promise.resolve({ id: ROUTE_NODE_ID }) }
    );
    expect(response.status).toBe(200);
    expect(routeMocks.readmit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "user-1",
        incidentId: "reliability.v1:candidate-a:poly:123",
      })
    );
    expect(routeMocks.readmit).not.toHaveBeenCalledWith(
      expect.objectContaining({ actorId: "system:spoof" })
    );
  });
});
