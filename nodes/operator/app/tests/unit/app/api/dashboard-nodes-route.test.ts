// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Authentication and delegation coverage for GET /api/v1/dashboard/nodes. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => vi.fn());
const listAccessible = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/server", () => ({
  getServerSessionUser: (...args: unknown[]) => session(...args),
}));

vi.mock("@/app/_facades/nodes/operations.server", () => ({
  listAccessibleNodeOperations: (...args: unknown[]) => listAccessible(...args),
}));

import { GET } from "@/app/api/v1/dashboard/nodes/route";

describe("GET /api/v1/dashboard/nodes", () => {
  beforeEach(() => {
    session.mockReset();
    listAccessible.mockReset();
  });

  it("returns 401 without a signed-in principal", async () => {
    session.mockResolvedValue(null);
    const response = await GET(
      new Request("https://operator.test/api/v1/dashboard/nodes")
    );
    expect(response.status).toBe(401);
    expect(listAccessible).not.toHaveBeenCalled();
  });

  it("delegates with the session user id", async () => {
    session.mockResolvedValue({ id: "user-a" });
    listAccessible.mockResolvedValue({ nodes: [] });
    const response = await GET(
      new Request("https://operator.test/api/v1/dashboard/nodes")
    );
    expect(response.status).toBe(200);
    expect(listAccessible).toHaveBeenCalledWith("user-a");
    await expect(response.json()).resolves.toEqual({ nodes: [] });
  });

  it("fails closed when the access-scoped read is unavailable", async () => {
    session.mockResolvedValue({ id: "user-a" });
    listAccessible.mockRejectedValue(new Error("db unavailable"));
    const response = await GET(
      new Request("https://operator.test/api/v1/dashboard/nodes")
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "operations unavailable",
    });
  });
});
