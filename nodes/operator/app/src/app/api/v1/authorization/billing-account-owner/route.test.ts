// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const NODE_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";
const authenticate = vi.fn();
const bootstrap = vi.fn();

vi.mock("@/app/_lib/authorization-facade-auth", () => ({
  authenticateAuthorizationFacadeRequest: authenticate,
}));
vi.mock("@/features/authorization", () => ({
  bootstrapNodeBillingAccountOwner: bootstrap,
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({ authorization: { writeRelations: vi.fn() } }),
}));
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_config: unknown, handler: (...args: unknown[]) => Promise<Response>) =>
    (request: Request) =>
      handler(
        {
          reqId: "req-1",
          routeId: "authorization.facade.billing_account_owner",
          log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        },
        request,
        null
      ),
}));

async function post(body: unknown): Promise<Response> {
  const { POST } = await import("./route");
  return POST(
    new Request(
      "https://operator.example/api/v1/authorization/billing-account-owner",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }
    ) as NextRequest
  );
}

describe("POST /api/v1/authorization/billing-account-owner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticate.mockResolvedValue({
      ok: true,
      node: { nodeId: NODE_ID, slug: "poly" },
    });
    bootstrap.mockResolvedValue({
      decision: "success",
      code: "authz_write_success",
    });
  });

  it("derives the node namespace from the workload credential", async () => {
    const input = {
      ownerUserId: USER_ID,
      billingAccountId: ACCOUNT_ID,
      requestId: "req-owner-1",
    };
    const response = await post(input);
    expect(response.status).toBe(200);
    expect(bootstrap).toHaveBeenCalledWith(
      expect.objectContaining({ authorization: expect.any(Object) }),
      NODE_ID,
      input
    );
  });

  it("rejects caller-supplied namespaces and tuples before auth IO", async () => {
    const response = await post({
      ownerUserId: USER_ID,
      billingAccountId: ACCOUNT_ID,
      nodeId: NODE_ID,
      relation: "owner",
    });
    expect(response.status).toBe(400);
    expect(authenticate).not.toHaveBeenCalled();
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it("fails closed when OpenFGA cannot verify the owner write", async () => {
    bootstrap.mockResolvedValueOnce({
      decision: "failure",
      code: "authz_write_unavailable",
      reason: "offline",
    });
    const response = await post({
      ownerUserId: USER_ID,
      billingAccountId: ACCOUNT_ID,
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "authz_write_unavailable",
    });
  });
});
