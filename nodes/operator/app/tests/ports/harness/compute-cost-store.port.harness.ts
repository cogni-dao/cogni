// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/ports/harness/compute-cost-store.port`
 * Purpose: Reusable behavior contract for paid-compute resource allocation stores.
 * Scope: Port semantics against a real persistence adapter supplied by the component test.
 * Invariants: PREPARE_BEFORE_PROVIDER_IO, NODE_ID_IS_SOLE_GROUPING_KEY,
 *   ONE_INTERVAL_PER_RESOURCE, IDEMPOTENT_EQUIVALENT_INPUT, MONOTONIC_EVIDENCE.
 * Side-effects: IO through the supplied store and test fixture database.
 * Links: src/ports/compute-cost-store.port.ts
 * @internal
 */

import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import type {
  ComputeCostReportPort,
  ComputeCostStorePort,
  ComputeResourceCostContext,
  ComputeResourceCostEvidence,
} from "@/ports";
import { ComputeCostInvariantError } from "@/ports";

const SHA = "a".repeat(40);
const PREPARED_AT = new Date("2026-09-11T18:00:00.000Z");
const OBSERVED_AT = new Date("2026-09-11T18:02:00.000Z");

function context(nodeId: string, suffix: string): ComputeResourceCostContext {
  return {
    attemptKey: `candidate-a:test:${suffix}`,
    nodeId,
    environment: "candidate-a",
    workloadUid: `workload-${suffix}`,
    workloadGeneration: 1,
    sourceSha: SHA,
    resourceShape: {
      services: [
        {
          name: "app",
          cpuUnits: 500,
          memoryMi: 512,
          storageMi: 1024,
        },
      ],
    },
    preparedAt: PREPARED_AT,
  };
}

function evidence(
  resourceId: string,
  overrides: Partial<ComputeResourceCostEvidence> = {}
): ComputeResourceCostEvidence {
  return {
    computeProvider: "marketplace-a",
    resourceId,
    computeProviderAccountId: "consumer-account-1",
    computeSupplierAccountId: "supplier-account-1",
    rate: { amount: "0.0001", denom: "utoken", unit: "block" },
    providerOpenedAtPosition: "100",
    escrow: {
      state: "open",
      funds: [{ amount: "5.00", denom: "utoken" }],
      transferred: [{ amount: "0.30", denom: "utoken" }],
    },
    observedAt: OBSERVED_AT,
    ...overrides,
  };
}

export function registerComputeCostStoreContract(
  makeStore: () => Promise<ComputeCostStorePort & ComputeCostReportPort>
): void {
  describe("ComputeCostStore port contract", () => {
    let store: ComputeCostStorePort & ComputeCostReportPort;
    let nodeId: string;

    beforeEach(async () => {
      store = await makeStore();
      nodeId = randomUUID();
    });

    it("persists node context before allocation and is idempotent only for equivalent input", async () => {
      const input = context(nodeId, randomUUID());
      const first = await store.prepare(input);
      const second = await store.prepare(input);

      expect(first).toEqual({ ...input, state: "prepared" });
      expect(second).toEqual(first);

      await expect(
        store.prepare({ ...input, environment: "preview" })
      ).rejects.toBeInstanceOf(ComputeCostInvariantError);
      const anotherNode = randomUUID();
      const secondNodeInterval = await store.prepare(
        context(anotherNode, randomUUID())
      );
      expect(secondNodeInterval.nodeId).toBe(anotherNode);
    });

    it("binds one provider resource to exactly one prepared attempt", async () => {
      const one = context(nodeId, randomUUID());
      const two = context(nodeId, randomUUID());
      const costEvidence = evidence(`resource-${randomUUID()}`);
      await store.prepare(one);
      await store.prepare(two);

      await expect(
        store.observe({ attemptKey: one.attemptKey, evidence: costEvidence })
      ).rejects.toBeInstanceOf(ComputeCostInvariantError);

      const bound = await store.bind({
        attemptKey: one.attemptKey,
        resource: costEvidence,
      });
      expect(bound.state).toBe("allocated");
      expect(bound.resource).toEqual({
        computeProvider: costEvidence.computeProvider,
        resourceId: costEvidence.resourceId,
      });
      expect(bound.evidence).toBeUndefined();
      expect(
        await store.findByResource({
          computeProvider: costEvidence.computeProvider,
          resourceId: costEvidence.resourceId,
        })
      ).toEqual(bound);

      expect(
        await store.bind({ attemptKey: one.attemptKey, resource: costEvidence })
      ).toEqual(bound);
      await expect(
        store.bind({ attemptKey: two.attemptKey, resource: costEvidence })
      ).rejects.toBeInstanceOf(ComputeCostInvariantError);

      const active = await store.observe({
        attemptKey: one.attemptKey,
        evidence: costEvidence,
      });
      expect(active.state).toBe("active");
      expect(active.evidence).toEqual(costEvidence);
    });

    it("accepts only monotonic observations and a one-way close", async () => {
      const input = context(nodeId, randomUUID());
      const initial = evidence(`resource-${randomUUID()}`);
      await store.prepare(input);
      await store.bind({ attemptKey: input.attemptKey, resource: initial });
      await store.observe({ attemptKey: input.attemptKey, evidence: initial });

      const stale = evidence(initial.resourceId, {
        providerClosedAtPosition: "120",
        observedAt: new Date("2026-09-11T18:01:30.000Z"),
        escrow: {
          state: "closed",
          providerSettledAtPosition: "115",
          funds: [{ amount: "1.00", denom: "utoken" }],
          transferred: [{ amount: "0.10", denom: "utoken" }],
        },
      });
      const ignored = await store.observe({
        attemptKey: input.attemptKey,
        evidence: stale,
      });
      expect(ignored.evidence).toEqual(initial);

      await expect(
        store.observe({
          attemptKey: input.attemptKey,
          evidence: evidence(initial.resourceId, {
            observedAt: new Date("2026-09-11T18:03:00.000Z"),
            escrow: {
              state: "open",
              funds: [{ amount: "5.00", denom: "utoken" }],
              transferred: [{ amount: "0.20", denom: "utoken" }],
            },
          }),
        })
      ).rejects.toBeInstanceOf(ComputeCostInvariantError);

      await expect(
        store.observe({
          attemptKey: input.attemptKey,
          evidence: evidence(initial.resourceId, {
            computeSupplierAccountId: "different-supplier",
            observedAt: new Date("2026-09-11T18:03:00.000Z"),
          }),
        })
      ).rejects.toBeInstanceOf(ComputeCostInvariantError);

      const closedRecordedAt = new Date("2026-09-11T18:05:00.000Z");
      const closed = await store.observe({
        attemptKey: input.attemptKey,
        evidence: evidence(initial.resourceId, {
          providerClosedAtPosition: "150",
          observedAt: closedRecordedAt,
          escrow: {
            state: "closed",
            providerSettledAtPosition: "160",
            funds: [],
            transferred: [{ amount: "0.75", denom: "utoken" }],
          },
        }),
      });
      expect(closed.state).toBe("closed");
      expect(closed.evidence?.providerClosedAtPosition).toBe("150");
      expect(closed.closedRecordedAt).toEqual(closedRecordedAt);

      const settledLater = await store.observe({
        attemptKey: input.attemptKey,
        evidence: evidence(initial.resourceId, {
          providerClosedAtPosition: "150",
          observedAt: new Date("2026-09-11T18:06:00.000Z"),
          escrow: {
            state: "closed",
            providerSettledAtPosition: "170",
            funds: [],
            transferred: [{ amount: "0.80", denom: "utoken" }],
          },
        }),
      });
      expect(settledLater.evidence?.escrow?.providerSettledAtPosition).toBe(
        "170"
      );

      await expect(
        store.observe({
          attemptKey: input.attemptKey,
          evidence: evidence(initial.resourceId, {
            providerClosedAtPosition: "150",
            observedAt: new Date("2026-09-11T18:07:00.000Z"),
            escrow: {
              state: "closed",
              providerSettledAtPosition: "165",
              funds: [],
              transferred: [{ amount: "0.85", denom: "utoken" }],
            },
          }),
        })
      ).rejects.toBeInstanceOf(ComputeCostInvariantError);

      await expect(
        store.observe({
          attemptKey: input.attemptKey,
          evidence: evidence(initial.resourceId, {
            providerClosedAtPosition: "151",
            observedAt: new Date("2026-09-11T18:07:00.000Z"),
          }),
        })
      ).rejects.toBeInstanceOf(ComputeCostInvariantError);
    });

    it("rejects conflicting evidence reported at the same observedAt", async () => {
      const input = context(nodeId, randomUUID());
      const initial = evidence(`resource-${randomUUID()}`);
      await store.prepare(input);
      await store.bind({ attemptKey: input.attemptKey, resource: initial });
      const active = await store.observe({
        attemptKey: input.attemptKey,
        evidence: initial,
      });

      const conflicts: readonly ComputeResourceCostEvidence[] = [
        evidence(initial.resourceId, {
          rate: { amount: "0.0002", denom: "utoken", unit: "block" },
        }),
        evidence(initial.resourceId, {
          providerOpenedAtPosition: "101",
        }),
        evidence(initial.resourceId, {
          providerClosedAtPosition: "150",
        }),
        evidence(initial.resourceId, {
          escrow: {
            state: "open",
            funds: [{ amount: "4.99", denom: "utoken" }],
            transferred: [{ amount: "0.30", denom: "utoken" }],
          },
        }),
        evidence(initial.resourceId, {
          escrow: {
            state: "settling",
            funds: [{ amount: "5.00", denom: "utoken" }],
            transferred: [{ amount: "0.30", denom: "utoken" }],
          },
        }),
        evidence(initial.resourceId, {
          escrow: {
            state: "open",
            providerSettledAtPosition: "110",
            funds: [{ amount: "5.00", denom: "utoken" }],
            transferred: [{ amount: "0.30", denom: "utoken" }],
          },
        }),
      ];

      for (const conflict of conflicts) {
        await expect(
          store.observe({ attemptKey: input.attemptKey, evidence: conflict })
        ).rejects.toBeInstanceOf(ComputeCostInvariantError);
      }
      expect(
        await store.findByResource({
          computeProvider: initial.computeProvider,
          resourceId: initial.resourceId,
        })
      ).toEqual(active);
    });

    it("records closure after allocation even when final provider evidence is unavailable", async () => {
      const input = context(nodeId, randomUUID());
      const resource = {
        computeProvider: "marketplace-a",
        resourceId: `resource-${randomUUID()}`,
      };
      await store.prepare(input);
      await store.bind({ attemptKey: input.attemptKey, resource });

      const closedRecordedAt = new Date("2026-09-11T18:07:00.000Z");
      const closed = await store.close({
        attemptKey: input.attemptKey,
        closedRecordedAt,
      });
      expect(closed).toEqual({
        ...input,
        state: "closed",
        resource,
        closedRecordedAt,
      });
      expect(
        await store.close({
          attemptKey: input.attemptKey,
          closedRecordedAt: new Date("2026-09-11T18:08:00.000Z"),
        })
      ).toEqual(closed);
      await expect(
        store.close({
          attemptKey: input.attemptKey,
          closedRecordedAt: new Date("2026-09-11T18:06:00.000Z"),
        })
      ).rejects.toBeInstanceOf(ComputeCostInvariantError);
    });

    it("reports exact native spend and active rate grouped only by node_id", async () => {
      const secondNodeId = randomUUID();
      const activeOne = context(nodeId, randomUUID());
      const activeTwo = context(nodeId, randomUUID());
      const closed = context(nodeId, randomUUID());
      const prepared = context(nodeId, randomUUID());
      await Promise.all(
        [activeOne, activeTwo, closed, prepared].map((item) =>
          store.prepare(item)
        )
      );
      const activeOneEvidence = evidence(`resource-${randomUUID()}`);
      const activeTwoEvidence = evidence(`resource-${randomUUID()}`, {
        rate: { amount: "0.0002", denom: "utoken", unit: "block" },
        escrow: {
          state: "open",
          funds: [{ amount: "4.00", denom: "utoken" }],
          transferred: [{ amount: "0.70", denom: "utoken" }],
        },
      });
      const closedEvidence = evidence(`resource-${randomUUID()}`, {
        rate: { amount: "0.0004", denom: "utoken", unit: "block" },
        providerClosedAtPosition: "150",
        escrow: {
          state: "closed",
          funds: [],
          transferred: [
            { amount: "1.10", denom: "utoken" },
            { amount: "2", denom: "uother" },
          ],
        },
      });
      await store.bind({
        attemptKey: activeOne.attemptKey,
        resource: activeOneEvidence,
      });
      await store.observe({
        attemptKey: activeOne.attemptKey,
        evidence: activeOneEvidence,
      });
      await store.bind({
        attemptKey: activeTwo.attemptKey,
        resource: activeTwoEvidence,
      });
      await store.observe({
        attemptKey: activeTwo.attemptKey,
        evidence: activeTwoEvidence,
      });
      await store.bind({
        attemptKey: closed.attemptKey,
        resource: closedEvidence,
      });
      await store.observe({
        attemptKey: closed.attemptKey,
        evidence: closedEvidence,
      });
      const secondNode = context(secondNodeId, randomUUID());
      const secondNodeEvidence = evidence(`resource-${randomUUID()}`, {
        escrow: {
          state: "open",
          funds: [{ amount: "10", denom: "utoken" }],
          transferred: [{ amount: "9", denom: "utoken" }],
        },
      });
      await store.prepare(secondNode);
      await store.bind({
        attemptKey: secondNode.attemptKey,
        resource: secondNodeEvidence,
      });
      await store.observe({
        attemptKey: secondNode.attemptKey,
        evidence: secondNodeEvidence,
      });

      const reports = await store.reportByNode();
      const report = reports.find((item) => item.nodeId === nodeId);
      expect(report).toEqual({
        nodeId,
        preparedIntervals: 1,
        allocatedIntervals: 0,
        activeIntervals: 2,
        closedIntervals: 1,
        transferred: [
          { amount: "2", denom: "uother" },
          { amount: "2.1", denom: "utoken" },
        ],
        activeRates: [{ amount: "0.0003", denom: "utoken", unit: "block" }],
      });
      expect(report).not.toHaveProperty("daoAddress");
      expect(report).not.toHaveProperty("billingAccountId");
      expect(report).not.toHaveProperty("actorId");
      expect(
        reports.find((item) => item.nodeId === secondNodeId)
      ).toMatchObject({
        nodeId: secondNodeId,
        activeIntervals: 1,
        transferred: [{ amount: "9", denom: "utoken" }],
      });
      expect(reports).toHaveLength(2);
    });
  });
}
