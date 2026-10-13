// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";
import {
  evaluateReliabilityPolicy,
  reconcileReliabilityContainment,
  runReliabilitySweep,
} from "@/features/nodes/reliability-status";
import type { DatabaseContainmentPort, MetricsQueryPort } from "@/ports";

const healthy = {
  buildSha: "0123456789abcdef",
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
  regionalReadiness: [{ healthy: true }, { healthy: true }],
  utilization: {
    ioPressurePct: 2,
    connectionPct: 20,
    memoryHeadroomPct: 70,
    diskHeadroomPct: 70,
  },
};

describe("ReliabilityStatusV1 policy", () => {
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

  it("returns healthy only with two healthy regions and full headroom", () => {
    expect(evaluateReliabilityPolicy(healthy)).toEqual({
      state: "healthy",
      reason: null,
    });
  });

  it("automatically invokes the audited containment port on critical", async () => {
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
            region: "us",
            healthy: true,
            observedAt: "2026-10-13T20:00:00.000Z",
          },
          {
            region: "eu",
            healthy: true,
            observedAt: "2026-10-13T20:00:00.000Z",
          },
        ],
        ioPressurePct: 20,
        connectionPct: 20,
        memoryHeadroomPct: 70,
        diskHeadroomPct: 70,
        evidenceQueryRefs: ["reliability.v1:test"],
      }),
    } as MetricsQueryPort;

    const status = await reconcileReliabilityContainment(
      {
        nodeId: healthy.database.nodeId,
        slug: healthy.database.nodeSlug,
        environment: healthy.database.environment,
        buildSha: healthy.buildSha,
        desiredTier: healthy.database.desiredTier,
        budgetProfile: healthy.database.budgetProfile,
        incidentId: "replay-1",
      },
      { metrics, containment }
    );

    expect(status.state).toBe("contained");
    expect(actions).toEqual([
      expect.objectContaining({
        reason: "critical_io_pressure",
        actorId: "system:reliability-controller.v1",
        incidentId: "replay-1",
      }),
    ]);
  });

  it("continues a bounded sweep when one target fails", async () => {
    const targets = [
      {
        nodeId: "11111111-1111-4111-8111-111111111111",
        slug: "broken",
        environment: "candidate-a" as const,
        desiredTier: "shared" as const,
        budgetProfile: "shared-small",
      },
      {
        nodeId: healthy.database.nodeId,
        slug: healthy.database.nodeSlug,
        environment: "candidate-a" as const,
        desiredTier: "shared" as const,
        budgetProfile: "shared-small",
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
            region: "us",
            healthy: true,
            observedAt: healthy.database.observedAt,
          },
          {
            region: "eu",
            healthy: true,
            observedAt: healthy.database.observedAt,
          },
        ],
        ioPressurePct: 2,
        connectionPct: 20,
        memoryHeadroomPct: 70,
        diskHeadroomPct: 70,
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
