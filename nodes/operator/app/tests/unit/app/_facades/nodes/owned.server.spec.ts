// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Unit coverage for the minimal owner-scoped node list facade. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { listOwnedNodes } from "@/app/_facades/nodes/owned.server";

const containerMocks = vi.hoisted(() => ({
  resolveAppDb: vi.fn(),
}));

const tenantMocks = vi.hoisted(() => ({
  withTenantScope: vi.fn(),
}));

vi.mock("@/bootstrap/container", () => containerMocks);
vi.mock("@cogni/db-client", () => tenantMocks);

function query(rows: readonly unknown[]) {
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(async () => rows),
  };
  return chain;
}

describe("app/_facades/nodes/owned.server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    containerMocks.resolveAppDb.mockReturnValue({ marker: "app-db" });
  });

  it("performs one tenant-scoped query and returns only list fields", async () => {
    const rows = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        slug: "alpha-node",
        status: "active",
      },
    ];
    const tx = { select: vi.fn(() => query(rows)) };
    tenantMocks.withTenantScope.mockImplementation(
      async (_db, _actor, run: (transaction: typeof tx) => Promise<unknown>) =>
        run(tx)
    );

    await expect(listOwnedNodes("user-1")).resolves.toEqual(rows);
    expect(containerMocks.resolveAppDb).toHaveBeenCalledTimes(1);
    expect(tenantMocks.withTenantScope).toHaveBeenCalledTimes(1);
    expect(tx.select).toHaveBeenCalledTimes(1);
  });

  it("propagates database failures", async () => {
    tenantMocks.withTenantScope.mockRejectedValueOnce(new Error("db down"));

    await expect(listOwnedNodes("user-1")).rejects.toThrow("db down");
  });
});
