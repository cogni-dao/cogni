// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/governance-sync-job-scope`
 * Purpose: Prove runGovernanceSchedulesSyncJob's scope option (task.5282): "self" syncs only the operator's own charters.
 * Scope: Unit test with every IO dep mocked; does not touch Temporal, Postgres, GitHub, or the catalog registry.
 * Invariants:
 *   - SELF_SCOPE_NEEDS_NO_REGISTRY: "self" never calls resolveRoutableNodeGovernanceConfigs
 *   - FOREIGN_LEDGER_ONLY: foreign desired writes and prune candidates exclude sovereign charters
 *   - LOCK_RACE_RETRIABLE: throwIfLocked surfaces a held advisory lock as an error
 * Side-effects: none
 * Links: src/bootstrap/jobs/syncGovernanceSchedules.job.ts
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const OPERATOR_NODE_ID = "operator-node-id";

const mocks = vi.hoisted(() => ({
  syncGovernanceSchedules: vi.fn(),
  resolveRoutableNodeGovernanceConfigs: vi.fn(),
  lockAcquired: { value: true },
  describeSchedule: vi.fn(),
  triggerSchedule: vi.fn(),
  listScheduleIds: vi.fn(),
  ownConfig: {
    schedules: [] as Array<{
      charter: string;
      cron: string;
      timezone: string;
      entrypoint: string;
    }>,
  },
}));

vi.mock("@cogni/scheduler-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cogni/scheduler-core")>()),
  syncGovernanceSchedules: mocks.syncGovernanceSchedules,
}));

vi.mock("@/bootstrap/jobs/resolveRoutableNodeGovernanceConfigs", () => ({
  resolveRoutableNodeGovernanceConfigs:
    mocks.resolveRoutableNodeGovernanceConfigs,
}));

vi.mock("@/shared/config", () => ({
  getGovernanceConfig: () => mocks.ownConfig,
  getNodeId: () => OPERATOR_NODE_ID,
}));

vi.mock("@/shared/env/server-env", () => ({
  serverEnv: () => ({ GOVERNANCE_SCHEDULES_ENABLED: true }),
}));

vi.mock("@/shared/db/schema", () => ({ schedules: {} }));

vi.mock("@/adapters/server/db/drizzle.service-client", () => ({
  getServiceDb: () => ({
    $client: {
      reserve: async () =>
        Object.assign(
          async (strings: TemplateStringsArray) =>
            strings.join("").includes("pg_try_advisory_lock")
              ? [{ acquired: mocks.lockAcquired.value }]
              : [],
          { release: vi.fn() }
        ),
    },
  }),
}));

vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    log: { info: vi.fn(), warn: vi.fn() },
    executionGrantPort: { ensureGrant: vi.fn() },
    scheduleControl: {
      describeSchedule: mocks.describeSchedule,
      triggerSchedule: mocks.triggerSchedule,
      listScheduleIds: mocks.listScheduleIds,
    },
  }),
}));

import {
  GovernanceSyncLockedError,
  runGovernanceSchedulesSyncJob,
} from "@/bootstrap/jobs/syncGovernanceSchedules.job";

const EMPTY = {
  created: [],
  updated: [],
  resumed: [],
  skipped: [],
  paused: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lockAcquired.value = true;
  mocks.ownConfig.schedules = [];
  mocks.listScheduleIds.mockResolvedValue([]);
  mocks.syncGovernanceSchedules.mockResolvedValue({
    ...EMPTY,
    created: ["governance:work_prioritizer"],
  });
  mocks.resolveRoutableNodeGovernanceConfigs.mockResolvedValue([
    { nodeId: OPERATOR_NODE_ID, slug: "operator", config: { schedules: [] } },
    { nodeId: "node-b", slug: "b", config: { schedules: [] } },
  ]);
  mocks.describeSchedule.mockResolvedValue(null);
});

describe("runGovernanceSchedulesSyncJob scope", () => {
  it('"self" syncs only the operator (isOperatorNode) and never reads the registry', async () => {
    const summary = await runGovernanceSchedulesSyncJob({ scope: "self" });

    expect(mocks.resolveRoutableNodeGovernanceConfigs).not.toHaveBeenCalled();
    expect(mocks.syncGovernanceSchedules).toHaveBeenCalledOnce();
    expect(mocks.syncGovernanceSchedules.mock.calls[0]?.[1]).toMatchObject({
      nodeId: OPERATOR_NODE_ID,
      isOperatorNode: true,
    });
    expect(mocks.describeSchedule).not.toHaveBeenCalled();
    expect(summary.created).toBe(1);
  });

  it('default ("all") is unchanged: operator first, then each routable non-operator node', async () => {
    const summary = await runGovernanceSchedulesSyncJob();

    expect(mocks.resolveRoutableNodeGovernanceConfigs).toHaveBeenCalledOnce();
    const calls = mocks.syncGovernanceSchedules.mock.calls.map(
      ([, deps]) => [deps.nodeId, deps.isOperatorNode] as const
    );
    expect(calls).toEqual([
      [OPERATOR_NODE_ID, true],
      ["node-b", false],
    ]);
    expect(summary.created).toBe(2);
  });

  it("limits foreign desired writes and prune ownership to Ledger while retaining own charters", async () => {
    const entry = (charter: string) => ({
      charter,
      cron: "0 * * * *",
      timezone: "UTC",
      entrypoint: "DECIDE",
    });
    mocks.ownConfig.schedules = [entry("HEARTBEAT"), entry("LEDGER_INGEST")];
    const ledger = entry("ledger_ingest");
    mocks.resolveRoutableNodeGovernanceConfigs.mockResolvedValue([
      {
        nodeId: "node-b",
        slug: "b",
        config: {
          schedules: [
            entry("MISSION_DECIDE"),
            entry("WORK_PRIORITIZER"),
            ledger,
          ],
        },
      },
    ]);
    mocks.listScheduleIds.mockResolvedValue([
      "governance:heartbeat",
      "governance:ledger_ingest",
      "governance:retired_charter",
      "governance:node-b:mission_decide",
      "governance:node-b:work_prioritizer",
      "governance:node-b:ledger_ingest",
      "governance:node-b:ledger_ingest_extra",
      "governance:node-c:ledger_ingest",
    ]);
    await runGovernanceSchedulesSyncJob();

    const [own, foreign] = mocks.syncGovernanceSchedules.mock.calls;
    expect(own?.[0]).toBe(mocks.ownConfig);
    expect(await own?.[1].listGovernanceScheduleIds()).toEqual([
      "governance:heartbeat",
      "governance:ledger_ingest",
      "governance:retired_charter",
    ]);
    expect.soft(foreign?.[0].schedules).toEqual([ledger]);
    expect
      .soft(await foreign?.[1].listGovernanceScheduleIds())
      .toEqual(["governance:node-b:ledger_ingest"]);
    expect(mocks.listScheduleIds).toHaveBeenLastCalledWith(
      "governance:node-b:"
    );

    // Even with no desired Ledger, its stale dispatch remains a prune candidate.
    mocks.resolveRoutableNodeGovernanceConfigs.mockResolvedValue([
      {
        nodeId: "node-b",
        slug: "b",
        config: { schedules: [entry("MISSION_DECIDE")] },
      },
    ]);
    await runGovernanceSchedulesSyncJob();
    const withoutLedger = mocks.syncGovernanceSchedules.mock.calls[3];
    expect(withoutLedger?.[0].schedules).toEqual([]);
    expect(await withoutLedger?.[1].listGovernanceScheduleIds()).toEqual([
      "governance:node-b:ledger_ingest",
    ]);
  });

  it('explicit "all" matches the default', async () => {
    await runGovernanceSchedulesSyncJob({ scope: "all" });
    expect(mocks.resolveRoutableNodeGovernanceConfigs).toHaveBeenCalledOnce();
    expect(mocks.syncGovernanceSchedules).toHaveBeenCalledTimes(2);
  });

  it("returns a no-op summary on a held lock, or throws with throwIfLocked (boot retries)", async () => {
    mocks.lockAcquired.value = false;
    await expect(runGovernanceSchedulesSyncJob()).resolves.toEqual({
      created: 0,
      updated: 0,
      resumed: 0,
      skipped: 0,
      paused: 0,
    });
    await expect(
      runGovernanceSchedulesSyncJob({ scope: "self", throwIfLocked: true })
    ).rejects.toBeInstanceOf(GovernanceSyncLockedError);
    expect(mocks.syncGovernanceSchedules).not.toHaveBeenCalled();
  });
});
