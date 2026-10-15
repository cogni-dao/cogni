// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it, vi } from "vitest";
import {
  DedicatedCellPressureController,
  knownCriticalDedicatedPressure,
} from "@/features/nodes/dedicated-cell-pressure";
import type {
  DatabaseCellPressureObservation,
  DatabaseContainmentStatus,
  DatabaseRecoveryIncident,
} from "@/ports";

const started = Date.parse("2026-10-15T00:00:00Z");
const sha = "a".repeat(40);
function samples(): DatabaseCellPressureObservation[] {
  return [0, 10_000, 20_000].map((offset) => ({
    nodeId: "11111111-1111-4111-8111-111111111111",
    nodeSlug: "fixture",
    environment: "production",
    allocationReceiptId: "22222222-2222-4222-8222-222222222222",
    dseq: "123456789",
    providerAccount: `akash1${"a".repeat(38)}`,
    databaseName: "cogni_fixture",
    systemIdentifier: "123456789",
    targetBuildSha: sha,
    observedAt: new Date(started + offset).toISOString(),
    totalBackends: 15,
    roles: [
      {
        name: "app_fixture",
        kind: "app",
        connectionLimit: 4,
        connections: 0,
        active: 0,
        waiting: 0,
        idle: 0,
        idleInTransaction: 0,
      },
      {
        name: "service_fixture",
        kind: "service",
        connectionLimit: 8,
        connections: 7,
        active: 0,
        waiting: 0,
        idle: 7,
        idleInTransaction: 0,
      },
      {
        name: "replay_fixture",
        kind: "replay",
        connectionLimit: 8,
        connections: 6,
        active: 6,
        waiting: 2,
        idle: 0,
        idleInTransaction: 0,
      },
    ],
    queryRef: `native-pressure:${offset}`,
  }));
}
function evaluate(value = samples(), nowMs = started + 21_000) {
  return knownCriticalDedicatedPressure({
    samples: value,
    nowMs,
    targetBuildSha: sha,
  });
}

describe("known critical dedicated cell pressure", () => {
  it("contains at the inclusive 75% role budget and 40% attribution thresholds", () => {
    expect(evaluate()).toMatchObject({
      role: "replay_fixture",
      activeRoleBudgetPct: 75,
      attributedBackendsPct: 40,
      reason: "critical_connections",
    });
  });

  it("does not mistake idle clients for active noisy-neighbor work", () => {
    const idle = samples().map((sample) => ({
      ...sample,
      roles: sample.roles.map((role) => ({
        ...role,
        active: 0,
        waiting: 0,
        idle: role.connections,
      })),
    }));
    expect(evaluate(idle)).toBeNull();
  });

  it("retains the canonical 40% attribution floor rather than the 25% warning floor", () => {
    expect(
      evaluate(samples().map((sample) => ({ ...sample, totalBackends: 16 })))
    ).toBeNull();
  });

  it("requires active role budget pressure even when attribution is high", () => {
    const lowBudget = samples().map((sample) => ({
      ...sample,
      totalBackends: 12,
      roles: sample.roles.map((role) =>
        role.kind === "replay" ? { ...role, active: 5, connections: 5 } : role
      ),
    }));
    expect(evaluate(lowBudget)).toBeNull();
  });

  it("requires all three samples to satisfy policy", () => {
    const value = samples();
    const third = value[2];
    if (!third) throw new Error("fixture");
    value[2] = { ...third, totalBackends: 16 };
    expect(evaluate(value)).toBeNull();
    expect(evaluate(value.slice(0, 2))).toBeNull();
  });

  it("refuses changed lease, native system, app SHA, or role budget identity", () => {
    for (const change of [
      { dseq: "987654321" },
      { systemIdentifier: "987654321" },
      { targetBuildSha: "b".repeat(40) },
    ]) {
      const value = samples();
      const third = value[2];
      if (!third) throw new Error("fixture");
      value[2] = { ...third, ...change };
      expect(evaluate(value)).toBeNull();
    }
    const changed = samples().map((sample, index) =>
      index === 2
        ? {
            ...sample,
            roles: sample.roles.map((role) => ({
              ...role,
              connectionLimit: role.connectionLimit + 1,
            })),
          }
        : sample
    );
    expect(evaluate(changed)).toBeNull();
  });

  it("refuses stale, reordered, future, or too-frequent samples", () => {
    expect(evaluate(samples(), started + 40_000)).toBeNull();
    expect(evaluate(samples().reverse())).toBeNull();
    expect(evaluate(samples(), started + 15_000)).toBeNull();
    expect(
      evaluate(
        samples().map((sample, index) => ({
          ...sample,
          observedAt: new Date(started + index * 1_000).toISOString(),
        }))
      )
    ).toBeNull();
  });

  it("fails closed on impossible or non-finite native counters", () => {
    for (const totalBackends of [
      0,
      -1,
      2,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(
        evaluate(samples().map((sample) => ({ ...sample, totalBackends })))
      ).toBeNull();
    }
    const impossible = samples().map((sample) => ({
      ...sample,
      roles: sample.roles.map((role) => ({ ...role, idle: role.connections })),
    }));
    expect(evaluate(impossible)).toBeNull();
  });
});

describe("dedicated pressure controller", () => {
  function setup() {
    let now = started;
    const queue = samples();
    const status: DatabaseContainmentStatus = {
      nodeId: "11111111-1111-4111-8111-111111111111",
      nodeSlug: "fixture",
      environment: "production",
      desiredTier: "dedicated",
      budgetProfile: "fixture",
      contained: true,
      phase: "contained",
      activeSessions: 0,
      rolesPresent: true,
      rolesCanLogin: false,
      firewallFenced: null,
      cell: null,
      observedAt: new Date(now).toISOString(),
      lastTransitionAt: null,
      incidentId: "actual-native-incident",
      reason: "critical_connections",
    };
    const observe = vi.fn(async () => {
      const sample = queue.shift();
      if (!sample) throw new Error("no sample");
      now = Date.parse(sample.observedAt) + 1000;
      return sample;
    });
    const contain = vi.fn(async () => status);
    const current = vi.fn<() => Promise<DatabaseRecoveryIncident | null>>(
      async () => null
    );
    const recontain = vi.fn();
    const actualSha = vi.fn(async () => sha);
    const controller = new DedicatedCellPressureController({
      pressure: { observe },
      containment: { contain, status: async () => status },
      recovery: { current, recontain },
      buildShaFor: actualSha,
      nowMs: () => now,
    });
    const target = {
      nodeId: status.nodeId,
      slug: "fixture",
      environment: "production" as const,
      desiredTier: "dedicated" as const,
      budgetProfile: "fixture",
      sourceSha: sha,
      cellId: "actual-owned-cell",
    };
    return {
      controller,
      target,
      observe,
      contain,
      current,
      recontain,
      actualSha,
    };
  }
  it("calls native containment only after three sustained attributed samples", async () => {
    const f = setup();
    expect((await f.controller.observe(f.target)).trigger).toBeNull();
    expect((await f.controller.observe(f.target)).trigger).toBeNull();
    expect(f.contain).not.toHaveBeenCalled();
    expect((await f.controller.observe(f.target)).containment?.phase).toBe(
      "contained"
    );
    expect(f.contain).toHaveBeenCalledOnce();
    expect(f.contain).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "system:dedicated-active-role-pressure.v1",
        reason: "critical_connections",
        cellId: "actual-owned-cell",
      })
    );
    expect(f.recontain).not.toHaveBeenCalled();
  });
  it("rejects a changed actual application before observing pressure or mutating roles", async () => {
    const f = setup();
    f.actualSha.mockResolvedValue("b".repeat(40));
    await expect(f.controller.observe(f.target)).rejects.toThrow(
      "current_app_sha_unproved"
    );
    expect(f.observe).not.toHaveBeenCalled();
    expect(f.contain).not.toHaveBeenCalled();
  });
  it("breaks sample continuity on observation failure", async () => {
    const f = setup();
    await f.controller.observe(f.target);
    f.observe.mockRejectedValueOnce(new Error("transport failure"));
    await expect(f.controller.observe(f.target)).rejects.toThrow(
      "transport failure"
    );
    await f.controller.observe(f.target);
    await f.controller.observe(f.target);
    expect(f.contain).not.toHaveBeenCalled();
  });
  it("refuses to report success unless native NOLOGIN and session drain are confirmed", async () => {
    const f = setup();
    f.contain.mockResolvedValue({
      ...(await f.contain()),
      contained: false,
      phase: "open",
    });
    f.contain.mockClear();
    await f.controller.observe(f.target);
    await f.controller.observe(f.target);
    await expect(f.controller.observe(f.target)).rejects.toThrow(
      "containment_not_confirmed"
    );
  });
  it("recontains a genuine unresolved incident without creating substitute history", async () => {
    const f = setup();
    f.current.mockResolvedValue({
      nodeId: f.target.nodeId,
      nodeSlug: "fixture",
      environment: "production",
      incidentId: "actual-existing-incident",
      actorId: "actual-original-actor",
      targetBuildSha: sha,
      databaseSystemIdentifier: "123456789",
      databaseName: "cogni_fixture",
      appRole: "app_fixture",
      serviceRole: "service_fixture",
      state: "recovering",
      reason: "critical_connections",
      containedAt: new Date(started - 60000).toISOString(),
      startedAt: new Date(started - 30000).toISOString(),
      deadlineAt: new Date(started + 570000).toISOString(),
      verifiedAt: null,
    });
    await f.controller.observe(f.target);
    await f.controller.observe(f.target);
    await f.controller.observe(f.target);
    expect(f.contain).not.toHaveBeenCalled();
    expect(f.recontain).toHaveBeenCalledWith(
      expect.objectContaining({
        incidentId: "actual-existing-incident",
        databaseSystemIdentifier: "123456789",
      })
    );
  });
});
