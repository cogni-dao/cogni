// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const NODE_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_ID = "44444444-4444-4444-8444-444444444444";
const resolveRequestPrincipal = vi.fn();
const check = vi.fn();
const getAcceptedStewardship = vi.fn();
const getBillingAccountById = vi.fn();

vi.mock("@/app/_lib/auth/request-identity", () => ({
  RequestIdentityUnavailableError: class RequestIdentityUnavailableError extends Error {},
  resolveRequestPrincipal,
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    nodeId: NODE_ID,
    billingAccountAuthorization: { check },
    agentIdentity: { getAcceptedStewardship },
    serviceAccountService: { getBillingAccountById },
  }),
}));
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_config: unknown, handler: (...args: unknown[]) => Promise<Response>) =>
    (request: Request, context?: unknown) =>
      handler(
        {
          reqId: "req-1",
          routeId: "accounts.agent_read",
          log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        },
        request,
        null,
        context
      ),
}));

async function get(id = ACCOUNT_ID): Promise<Response> {
  const { GET } = await import("./route");
  return GET(
    new Request(`https://node.example/api/v1/accounts/${id}`) as NextRequest,
    { params: Promise.resolve({ id }) }
  );
}

describe("GET /api/v1/accounts/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveRequestPrincipal.mockResolvedValue({
      kind: "agent",
      principalId: `agent:${NODE_ID}/${AGENT_ID}`,
      actorId: AGENT_ID,
      credentialId: "55555555-5555-4555-8555-555555555555",
      billingAccountId: ACCOUNT_ID,
      displayName: "Agent",
      legacyUserId: null,
    });
    getAcceptedStewardship.mockResolvedValue({
      stewardUserId: USER_ID,
      billingAccountId: ACCOUNT_ID,
    });
    getBillingAccountById.mockResolvedValue({
      id: ACCOUNT_ID,
      balanceCredits: 42,
    });
  });

  it("reads only after a direct exact-account allow", async () => {
    check.mockResolvedValueOnce({
      decision: "allow",
      code: "authz_allowed",
      checks: [],
    });
    const response = await get();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      billingAccountId: ACCOUNT_ID,
      balanceCredits: 42,
      accessMode: "direct",
    });
    expect(getBillingAccountById).toHaveBeenCalledWith(ACCOUNT_ID);
  });

  it("derives the OBO subject from accepted stewardship, never input", async () => {
    check
      .mockResolvedValueOnce({
        decision: "deny",
        code: "authz_denied",
        checks: [],
      })
      .mockResolvedValueOnce({
        decision: "allow",
        code: "authz_allowed",
        checks: [],
      });
    const response = await get();
    expect(response.status).toBe(200);
    expect(check).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ subjectId: `user:${NODE_ID}/${USER_ID}` })
    );
  });

  it("denies wrong-account or revoked access before the data read", async () => {
    check.mockResolvedValue({
      decision: "deny",
      code: "authz_denied",
      checks: [],
    });
    const response = await get(
      "66666666-6666-4666-8666-666666666666"
    );
    expect(response.status).toBe(403);
    expect(getBillingAccountById).not.toHaveBeenCalled();
  });

  it("rejects malformed account IDs before identity or authz IO", async () => {
    const response = await get("not-a-uuid");
    expect(response.status).toBe(400);
    expect(resolveRequestPrincipal).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  it("rejects foreign-node credentials as unauthenticated", async () => {
    resolveRequestPrincipal.mockResolvedValueOnce(null);
    const response = await get();
    expect(response.status).toBe(401);
    expect(check).not.toHaveBeenCalled();
    expect(getBillingAccountById).not.toHaveBeenCalled();
  });
});
