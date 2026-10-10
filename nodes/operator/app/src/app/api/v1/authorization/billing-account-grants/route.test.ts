// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authenticate = vi.fn();
const mutate = vi.fn();
const info = vi.fn();

const NODE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_NODE_ID = "22222222-2222-4222-8222-222222222222";
const GRANTOR_ID = "33333333-3333-4333-8333-333333333333";
const SUBJECT_ID = "44444444-4444-4444-8444-444444444444";
const AGENT_ID = "55555555-5555-4555-8555-555555555555";
const ACCOUNT_ID = "66666666-6666-4666-8666-666666666666";

vi.mock("@/app/_lib/authorization-facade-auth", () => ({
  authenticateAuthorizationFacadeRequest: authenticate,
}));
vi.mock("@/features/authorization", () => ({
  mutateNodeBillingAccountAccess: mutate,
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
          reqId: "req-server",
          log: { warn: vi.fn(), info, error: vi.fn() },
        },
        request,
        null
      ),
}));

const validBody = {
  operation: "grant",
  grantorUserId: GRANTOR_ID,
  billingAccountId: ACCOUNT_ID,
  target: { kind: "agent", id: AGENT_ID },
  role: "obo",
  subjectUserId: SUBJECT_ID,
  expiresAt: "2026-11-01T00:00:00.000Z",
  requestId: "req-node",
} as const;

async function post(body: unknown): Promise<Response> {
  const { POST } = await import("./route");
  return POST(
    new Request(
      "https://operator.example/api/v1/authorization/billing-account-grants",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }
    ) as NextRequest
  );
}

describe("POST /api/v1/authorization/billing-account-grants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticate.mockResolvedValue({
      ok: true,
      node: {
        nodeId: NODE_ID,
        slug: "poly",
        deployEnvs: ["production"],
        activityEnv: "production",
      },
    });
    mutate.mockResolvedValue({
      decision: "success",
      code: "authz_write_success",
    });
  });

  it("derives the node from the credential and emits the required semantic audit", async () => {
    const response = await post(validBody);
    expect(response.status).toBe(200);
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ authorization: expect.any(Object) }),
      NODE_ID,
      validBody
    );
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        authenticatedNodeId: NODE_ID,
        assertedGrantorUserId: GRANTOR_ID,
        billingAccountId: ACCOUNT_ID,
        semantic: {
          operation: "grant",
          role: "obo",
          targetKind: "agent",
          targetId: AGENT_ID,
          subjectUserId: SUBJECT_ID,
        },
        decision: "success",
        requestId: "req-node",
      }),
      "authorization_facade.mutation_decided"
    );
  });

  it("rejects any caller-supplied node or raw relation before policy", async () => {
    const response = await post({
      ...validBody,
      nodeId: OTHER_NODE_ID,
      relation: "owner",
    });
    expect(response.status).toBe(400);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("preserves grantor denial as 403 and unavailable as 503", async () => {
    mutate.mockResolvedValueOnce({
      decision: "failure",
      code: "authz_write_denied",
      reason: "grantor lacks can_grant",
    });
    expect((await post(validBody)).status).toBe(403);

    mutate.mockResolvedValueOnce({
      decision: "failure",
      code: "authz_write_unavailable",
      reason: "OpenFGA unavailable",
    });
    expect((await post(validBody)).status).toBe(503);
  });

  it("returns 429 without policy execution when the node credential is rate limited", async () => {
    authenticate.mockResolvedValue({
      ok: false,
      status: 429,
      errorCode: "rate_limited",
    });
    const response = await post(validBody);
    expect(response.status).toBe(429);
    expect(mutate).not.toHaveBeenCalled();
  });
});
