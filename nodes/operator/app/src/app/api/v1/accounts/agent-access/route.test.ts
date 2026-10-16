// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BillingAccountOwnerBootstrapPortError } from "@/ports";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";
const mutate = vi.fn();
const getAcceptedStewardship = vi.fn();
const getOrCreateBillingAccountForUser = vi.fn();
const info = vi.fn();

vi.mock("@/lib/auth/server", () => ({
  getServerSessionUser: vi.fn(),
}));
vi.mock("@/app/api/v1/agent/_shared", () => ({
  isSameOriginMutation: () => true,
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    accountsForUser: () => ({ getOrCreateBillingAccountForUser }),
    agentIdentity: { getAcceptedStewardship },
    billingAccountAuthorization: { mutateAgentAccountAccess: mutate },
  }),
}));
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_config: unknown, handler: (...args: unknown[]) => Promise<Response>) =>
    (request: Request) =>
      handler(
        {
          reqId: "req-1",
          routeId: "accounts.agent_access.mutate",
          log: { info, warn: vi.fn(), error: vi.fn() },
        },
        request,
        {
          id: USER_ID,
          walletAddress: "0x1234",
          displayName: "Human",
          avatarColor: null,
        }
      ),
}));

async function post(body: unknown): Promise<Response> {
  const { POST } = await import("./route");
  return POST(
    new Request("https://node.example/api/v1/accounts/agent-access", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://node.example",
      },
      body: JSON.stringify(body),
    }) as NextRequest
  );
}

describe("POST /api/v1/accounts/agent-access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getOrCreateBillingAccountForUser.mockResolvedValue({ id: ACCOUNT_ID });
    getAcceptedStewardship.mockResolvedValue({
      stewardUserId: USER_ID,
      billingAccountId: ACCOUNT_ID,
    });
    mutate.mockResolvedValue({
      decision: "success",
      code: "authz_write_success",
    });
  });

  it("binds the grantor and exact account from the human session", async () => {
    const response = await post({
      operation: "grant",
      agentActorId: AGENT_ID,
      mode: "on_behalf_of",
      expiresAt: "2026-11-01T00:00:00.000Z",
    });
    expect(response.status).toBe(200);
    expect(mutate).toHaveBeenCalledWith({
      operation: "grant",
      agentActorId: AGENT_ID,
      mode: "on_behalf_of",
      expiresAt: "2026-11-01T00:00:00.000Z",
      grantorUserId: USER_ID,
      billingAccountId: ACCOUNT_ID,
      requestId: "req-1",
    });
    expect(getOrCreateBillingAccountForUser).toHaveBeenCalledWith(
      expect.objectContaining({ requireAuthorizationOwner: true })
    );
  });

  it("rejects caller-supplied grantor/account fields before mutation", async () => {
    const response = await post({
      operation: "grant",
      agentActorId: AGENT_ID,
      mode: "direct",
      expiresAt: "2026-11-01T00:00:00.000Z",
      grantorUserId: USER_ID,
      billingAccountId: ACCOUNT_ID,
    });
    expect(response.status).toBe(400);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("denies an agent not accepted by this human without authz mutation", async () => {
    getAcceptedStewardship.mockResolvedValueOnce({
      stewardUserId: "44444444-4444-4444-8444-444444444444",
      billingAccountId: ACCOUNT_ID,
    });
    const response = await post({
      operation: "revoke",
      agentActorId: AGENT_ID,
      mode: "direct",
    });
    expect(response.status).toBe(403);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("fails closed when the initial owner projection is unavailable", async () => {
    getOrCreateBillingAccountForUser.mockRejectedValueOnce(
      new BillingAccountOwnerBootstrapPortError("OpenFGA unavailable")
    );
    const response = await post({
      operation: "grant",
      agentActorId: AGENT_ID,
      mode: "direct",
      expiresAt: "2026-11-01T00:00:00.000Z",
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "authz_write_unavailable",
    });
    expect(mutate).not.toHaveBeenCalled();
  });
});
