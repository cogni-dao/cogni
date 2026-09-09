// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/db/drizzle-catalog-node-registry.adapter`
 * Purpose: Prove catalog projection uses env-local ownership and preserves lifecycle state on update.
 * Scope: Mocked Drizzle transaction only; no PostgreSQL process.
 * Invariants: USER_IDS_ARE_ENV_LOCAL, STATUS_NEVER_REGRESSES, NODE_ID_IS_DEPLOYMENT_IDENTITY,
 *   PLACEMENT_IS_CATALOG_OWNED.
 * Side-effects: none
 * Links: src/adapters/server/db/drizzle-catalog-node-registry.adapter.ts
 * @internal
 */

import type { Database } from "@cogni/db-client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DrizzleCatalogNodeRegistryAdapter } from "@/adapters/server/db/drizzle-catalog-node-registry.adapter";
import type { CatalogNodeDefinition } from "@/ports/deploy-plane.port";

const DEFINITION: CatalogNodeDefinition = {
  nodeId: "11111111-1111-4111-8111-111111111111",
  slug: "atlas",
  repoUrl: "https://github.com/Cogni-DAO/atlas",
  repoOwner: "Cogni-DAO",
  repoName: "atlas",
  deployEnvs: ["candidate-a"],
  activityEnv: "candidate-a",
  ownerWallet: "0x070075F1389Ae1182aBac722B36CA12285d0c949",
  deploymentProviders: { "candidate-a": "akash" },
};

function makeSelectChain(rows: readonly { id: string }[]) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
}

function makeInsertChain(returnedId: string) {
  return {
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: returnedId }]),
  };
}

describe("DrizzleCatalogNodeRegistryAdapter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves the owner locally and omits status from conflict updates", async () => {
    const selectChain = makeSelectChain([{ id: "env-local-user" }]);
    const nodeInsert = makeInsertChain(DEFINITION.nodeId);
    const tx = {
      select: vi.fn(() => selectChain),
      insert: vi.fn(() => nodeInsert),
    };
    const db = {
      transaction: vi.fn(async (callback: (value: typeof tx) => unknown) =>
        callback(tx)
      ),
    } as unknown as Database;

    const result = await new DrizzleCatalogNodeRegistryAdapter(db).reconcile([
      DEFINITION,
    ]);

    expect(nodeInsert.values).toHaveBeenCalledWith(
      expect.objectContaining({
        id: DEFINITION.nodeId,
        ownerUserId: "env-local-user",
        deployEnvs: ["candidate-a"],
        activityEnv: "candidate-a",
        // PLACEMENT_IS_CATALOG_OWNED (bug.5106): the row's declared placement lands in the
        // registry, so the runtime address resolver can read WHERE this node runs.
        deploymentProviders: { "candidate-a": "akash" },
        status: "published",
      })
    );
    const conflict = nodeInsert.onConflictDoUpdate.mock.calls[0]?.[0] as {
      set: Record<string, unknown>;
    };
    expect(conflict.set).not.toHaveProperty("status");
    expect(conflict.set).not.toHaveProperty("id");
    // Placement is git intent — an existing row is re-stamped on every reconcile, so moving a
    // node between providers (or back to k3s) reaches the address resolver.
    expect(conflict.set.deploymentProviders).toEqual({
      "candidate-a": "akash",
    });
    expect(result).toEqual({
      projected: 1,
      owners: [{ nodeId: DEFINITION.nodeId, ownerUserId: "env-local-user" }],
    });
  });

  it("fails the transaction when a slug is already bound to another node_id", async () => {
    const selectChain = makeSelectChain([{ id: "env-local-user" }]);
    const nodeInsert = makeInsertChain("22222222-2222-4222-8222-222222222222");
    const tx = {
      select: vi.fn(() => selectChain),
      insert: vi.fn(() => nodeInsert),
    };
    const db = {
      transaction: vi.fn(async (callback: (value: typeof tx) => unknown) =>
        callback(tx)
      ),
    } as unknown as Database;

    await expect(
      new DrizzleCatalogNodeRegistryAdapter(db).reconcile([DEFINITION])
    ).rejects.toThrow(/catalog node identity mismatch/);
  });

  it("creates an environment-local user when the wallet is not present", async () => {
    const selectChain = makeSelectChain([]);
    const userInsert = {
      values: vi.fn().mockReturnThis(),
      onConflictDoNothing: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([{ id: "new-env-local-user" }]),
    };
    const nodeInsert = makeInsertChain(DEFINITION.nodeId);
    let insertCount = 0;
    const tx = {
      select: vi.fn(() => selectChain),
      insert: vi.fn(() => (insertCount++ === 0 ? userInsert : nodeInsert)),
    };
    const db = {
      transaction: vi.fn(async (callback: (value: typeof tx) => unknown) =>
        callback(tx)
      ),
    } as unknown as Database;

    const result = await new DrizzleCatalogNodeRegistryAdapter(db).reconcile([
      DEFINITION,
    ]);

    expect(userInsert.values).toHaveBeenCalledWith(
      expect.objectContaining({ walletAddress: DEFINITION.ownerWallet })
    );
    expect(nodeInsert.values).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId: "new-env-local-user" })
    );
    expect(result.owners[0]?.ownerUserId).toBe("new-env-local-user");
  });
});
