// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const NODE_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_ID = "44444444-4444-4444-8444-444444444444";
const authenticate = vi.fn();
const mutate = vi.fn();

vi.mock("@/app/_lib/authorization-facade-auth", () => ({
  authenticateAuthorizationFacadeRequest: authenticate,
}));
vi.mock("@/features/authorization", () => ({
  mutateNodeAgentAccountAccess: mutate,
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({ authorization: { check: vi.fn() } }),
}));
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_config: unknown, handler: (...args: unknown[]) => Promise<Response>) =>
    (request: Request) =>
      handler(
        {
          reqId: "req-1",
          routeId: "authorization.facade.agent_account_access",
          log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        },
        request,
        null
      ),
}));

const validBody = {
  operation: "grant",
  grantorUserId: USER_ID,
  billingAccountId: ACCOUNT_ID,
  agentActorId: AGENT_ID,
  mode: "on_behalf_of",
  expiresAt: "2026-11-01T00:00:00.000Z",
} as const;

async function post(body: unknown): Promise<Response> {
  const { POST } = await import("./route");
  return POST(
    new Request(
      "https://operator.example/api/v1/authorization/agent-account-access",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }
    ) as NextRequest
  );
}

describe("POST /api/v1/authorization/agent-account-access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticate.mockResolvedValue({
      ok: true,
      node: { nodeId: NODE_ID, slug: "poly" },
    });
    mutate.mockResolvedValue({
      decision: "success",
      code: "authz_write_success",
    });
  });

  it("derives node scope from the workload credential", async () => {
    const response = await post(validBody);
    expect(response.status).toBe(200);
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ authorization: expect.any(Object) }),
      NODE_ID,
      validBody
    );
  });

  it("rejects node IDs and raw tuples before auth or policy IO", async () => {
    const response = await post({
      ...validBody,
      nodeId: NODE_ID,
      relation: "owner",
      object: `billing_account:${NODE_ID}/${ACCOUNT_ID}`,
    });
    expect(response.status).toBe(400);
    expect(authenticate).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });
});
