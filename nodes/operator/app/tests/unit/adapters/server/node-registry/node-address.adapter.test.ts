// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/node-registry/node-address.adapter`
 * Purpose: Prove the operator resolves a node's address from that node's DECLARED placement —
 *   an akash-placed node to its EXTERNAL public address, a k3s-placed node to in-cluster Service
 *   DNS — and that the drizzle lookup reads the projection the catalog reconcile writes (bug.5106).
 * Scope: Injected placement lookup + a mocked drizzle select chain; no PostgreSQL, no network.
 * Invariants: PLACEMENT_DECIDES_THE_ADDRESS, K3S_IS_DEFAULT, UNKNOWN_NODE_IS_K3S,
 *   LOOKUP_FAILURE_IS_LOUD, NO_NODE_NAMES_IN_CODE.
 * Side-effects: none
 * Links: src/adapters/server/node-registry/node-address.adapter.ts,
 *   src/shared/node-registry/placement.ts, bug.5106
 * @internal
 */

import type { Database } from "@cogni/db-client";
import { describe, expect, it, vi } from "vitest";

import {
  createDrizzleNodePlacementLookup,
  createNodeAddressResolver,
  type NodePlacementLookup,
} from "@/adapters/server/node-registry/node-address.adapter";
import { NodeAddressError } from "@/ports";
import type { NodeDeploymentPlacement } from "@/shared/node-registry/placement";

/** Registry projection keyed by slug — exactly the shape `nodes.deployment_providers` holds. */
function registry(
  rows: Record<string, NodeDeploymentPlacement>
): NodePlacementLookup {
  return async (slug) => rows[slug] ?? null;
}

describe("createNodeAddressResolver", () => {
  const candidateA = {
    loadPlacement: registry({
      // Declared off-cluster in every env it deploys to.
      toks4: { "candidate-a": "akash", preview: "akash", production: "akash" },
      // Declares nothing → K3S_IS_DEFAULT.
      blue: {},
      // Off-cluster in prod only; still a cluster neighbour on candidate-a.
      habitat: { production: "akash" },
    }),
    environment: "candidate-a",
    apexDomain: "test.cognidao.org",
  } as const;

  it("resolves an akash-placed node to its EXTERNAL public address", async () => {
    const resolver = createNodeAddressResolver(candidateA);
    await expect(resolver.resolveNodeAppBaseUrl("toks4")).resolves.toBe(
      "https://toks4-test.cognidao.org"
    );
  });

  it("resolves a k3s-placed node to in-cluster Service DNS", async () => {
    const resolver = createNodeAddressResolver(candidateA);
    await expect(resolver.resolveNodeAppBaseUrl("blue")).resolves.toBe(
      "http://blue-node-app:3000"
    );
  });

  it("is per-environment: a prod-only akash row stays in-cluster on candidate-a", async () => {
    await expect(
      createNodeAddressResolver(candidateA).resolveNodeAppBaseUrl("habitat")
    ).resolves.toBe("http://habitat-node-app:3000");

    await expect(
      createNodeAddressResolver({
        ...candidateA,
        environment: "production",
        apexDomain: "cognidao.org",
      }).resolveNodeAppBaseUrl("habitat")
    ).resolves.toBe("https://habitat.cognidao.org");
  });

  it("keeps the historical in-cluster address for a node it has not projected", async () => {
    const resolver = createNodeAddressResolver(candidateA);
    await expect(resolver.resolveNodeAppBaseUrl("not-yet-known")).resolves.toBe(
      "http://not-yet-known-node-app:3000"
    );
  });

  it("throws NodeAddressError instead of returning an unreachable address", async () => {
    const resolver = createNodeAddressResolver({
      loadPlacement: registry({ toks4: { "candidate-a": "akash" } }),
      environment: "candidate-a",
      apexDomain: undefined,
    });
    await expect(
      resolver.resolveNodeAppBaseUrl("toks4")
    ).rejects.toBeInstanceOf(NodeAddressError);
  });

  it("propagates a registry read failure rather than silently defaulting to k3s", async () => {
    const resolver = createNodeAddressResolver({
      loadPlacement: async () => {
        throw new Error("connection terminated");
      },
      environment: "candidate-a",
      apexDomain: "test.cognidao.org",
    });
    await expect(resolver.resolveNodeAppBaseUrl("toks4")).rejects.toThrow(
      /connection terminated/
    );
  });
});

describe("createDrizzleNodePlacementLookup", () => {
  function dbReturning(rows: readonly unknown[]) {
    const chain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(rows),
    };
    return {
      db: { select: vi.fn(() => chain) } as unknown as Database,
      chain,
    };
  }

  it("reads the registry projection the catalog reconcile writes", async () => {
    const { db } = dbReturning([
      { deploymentProviders: { "candidate-a": "akash" } },
    ]);
    await expect(
      createDrizzleNodePlacementLookup(db)("toks4")
    ).resolves.toEqual({ "candidate-a": "akash" });
  });

  it("returns null for an unknown slug (caller keeps the k3s default)", async () => {
    const { db } = dbReturning([]);
    await expect(
      createDrizzleNodePlacementLookup(db)("ghost")
    ).resolves.toBeNull();
  });

  it("drops values outside the declared placement vocabulary", async () => {
    const { db } = dbReturning([
      { deploymentProviders: { "candidate-a": "fly-io", production: "akash" } },
    ]);
    await expect(
      createDrizzleNodePlacementLookup(db)("toks4")
    ).resolves.toEqual({ production: "akash" });
  });
});
