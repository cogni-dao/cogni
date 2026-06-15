// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/_facades/nodes/gallery.server`
 * Purpose: Unit coverage for the public nodes gallery read-model facade.
 * Scope: Mocks registry, service DB, attribution store, and claimant facade. No IO.
 * Side-effects: mocked dependency containers only
 * Links: src/app/_facades/nodes/gallery.server.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getNodeDetail,
  listNodeGallery,
} from "@/app/_facades/nodes/gallery.server";
import type { NodeSummary } from "@/ports";

const containerMocks = vi.hoisted(() => ({
  getContainer: vi.fn(),
  resolveNodeRegistry: vi.fn(),
  resolveServiceDb: vi.fn(),
}));

const claimantMocks = vi.hoisted(() => ({
  readFinalizedEpochClaimants: vi.fn(),
}));

vi.mock("@/bootstrap/container", () => containerMocks);

vi.mock("@/app/_facades/attribution/claimants.server", () => claimantMocks);

const alpha: NodeSummary = {
  slug: "alpha",
  nodeId: "11111111-1111-4111-8111-111111111111",
  title: "Alpha Node",
  tagline: "First node",
  kind: "full-app",
  href: "https://alpha-test.cognidao.org",
};

const beta: NodeSummary = {
  slug: "beta",
  title: "Beta Node",
  tagline: "",
  kind: "full-app",
  href: "#",
};

function query(rows: readonly unknown[]) {
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    groupBy: vi.fn(async () => rows),
  };
  return chain;
}

function mockReceiptCounts(): void {
  containerMocks.resolveServiceDb.mockReturnValue({
    select: vi
      .fn()
      .mockReturnValueOnce(query([{ nodeId: alpha.nodeId, count: "2" }]))
      .mockReturnValueOnce(query([{ nodeId: alpha.nodeId, count: 9n }])),
  });
}

describe("app/_facades/nodes/gallery.server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    containerMocks.resolveNodeRegistry.mockReturnValue({
      listPublic: vi.fn(async () => [alpha, beta]),
    });
    mockReceiptCounts();
    containerMocks.getContainer.mockReturnValue({
      attributionStore: {
        listEpochs: vi.fn(async (nodeId: string) =>
          nodeId === alpha.nodeId
            ? [
                {
                  id: 1n,
                  status: "open",
                  periodStart: new Date("2026-01-01T00:00:00.000Z"),
                  periodEnd: new Date("2026-01-31T00:00:00.000Z"),
                },
                {
                  id: 3n,
                  status: "finalized",
                  periodStart: new Date("2026-02-01T00:00:00.000Z"),
                  periodEnd: new Date("2026-02-28T00:00:00.000Z"),
                },
              ]
            : []
        ),
      },
    });
  });

  it("joins registry nodes to receipt counts and epoch summaries", async () => {
    const items = await listNodeGallery();

    expect(items).toHaveLength(2);
    expect(items[0]?.node.slug).toBe("alpha");
    expect(items[0]?.metrics.devActivity30d).toBe(2);
    expect(items[0]?.metrics.devActivityTotal).toBe(9);
    expect(items[0]?.metrics.latestEpoch).toEqual({
      id: "3",
      status: "finalized",
      periodStart: "2026-02-01T00:00:00.000Z",
      periodEnd: "2026-02-28T00:00:00.000Z",
    });
    expect(items[0]?.metrics.finalizedEpochCount).toBe(1);
    expect(items[0]?.metrics.aiUsage).toEqual({
      state: "unavailable",
      reason: "AI usage needs node-correlated charge receipts",
    });
    expect(items[1]?.metrics.devActivityTotal).toBe(0);
  });

  it("returns null for an unknown detail slug", async () => {
    expect(await getNodeDetail("missing")).toBeNull();
  });

  it("aggregates finalized epoch owners for detail view", async () => {
    mockReceiptCounts();
    claimantMocks.readFinalizedEpochClaimants.mockResolvedValueOnce({
      items: [
        {
          claimantKey: "user:1",
          displayName: "Ada",
          claimant: { kind: "user" },
          isLinked: true,
          amountCredits: "700",
        },
        {
          claimantKey: "wallet:0xabc",
          displayName: null,
          claimant: { kind: "wallet" },
          isLinked: false,
          amountCredits: 300,
        },
      ],
    });

    const detail = await getNodeDetail("alpha");

    expect(detail?.topOwners).toEqual([
      {
        claimantKey: "user:1",
        displayName: "Ada",
        claimantLabel: "Linked account",
        isLinked: true,
        totalCredits: 700,
        ownershipPercent: 70,
        epochsContributed: 1,
      },
      {
        claimantKey: "wallet:0xabc",
        displayName: null,
        claimantLabel: "Unlinked account",
        isLinked: false,
        totalCredits: 300,
        ownershipPercent: 30,
        epochsContributed: 1,
      },
    ]);
  });

  it("degrades epoch and owner reads when attribution storage is unavailable", async () => {
    mockReceiptCounts();
    containerMocks.getContainer.mockReturnValue({
      attributionStore: {
        listEpochs: vi.fn(async () => {
          throw new Error("attribution down");
        }),
      },
    });

    const detail = await getNodeDetail("alpha");

    expect(detail?.metrics.latestEpoch).toBeNull();
    expect(detail?.metrics.finalizedEpochCount).toBe(0);
    expect(detail?.topOwners).toEqual([]);
  });
});
