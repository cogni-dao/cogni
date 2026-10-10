// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authenticate = vi.fn();
const checkAccess = vi.fn();

const NODE_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_ID = "66666666-6666-4666-8666-666666666666";

vi.mock("@/app/_lib/authorization-facade-auth", () => ({
  authenticateAuthorizationFacadeRequest: authenticate,
}));
vi.mock("@/features/authorization", () => ({
  checkNodeBillingAccountAccess: checkAccess,
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
          reqId: "req-check",
          log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
        },
        request,
        null
      ),
}));

describe("POST /api/v1/authorization/check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticate.mockResolvedValue({
      ok: true,
      node: {
        nodeId: NODE_ID,
        slug: "poly",
        deployEnvs: ["production"],
        activityEnv: "production",
        deploymentProviders: {},
      },
    });
  });

  it("normalizes adapter-only condition context out of strict wire subchecks", async () => {
    checkAccess.mockResolvedValue({
      decision: "allow",
      code: "authz_allowed",
      checks: [
        {
          name: "permission",
          user: `user:${NODE_ID}/${USER_ID}`,
          relation: "can_read",
          object: `billing_account:${NODE_ID}/${ACCOUNT_ID}`,
          context: { current_time: "2026-10-09T00:00:00.000Z" },
          decision: "allow",
          code: "authz_allowed",
        },
      ],
    });
    const { POST } = await import("./route");
    const response = await POST(
      new Request("https://operator.example/api/v1/authorization/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actor: { kind: "user", id: USER_ID },
          billingAccountId: ACCOUNT_ID,
        }),
      }) as NextRequest
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      decision: "allow",
      code: "authz_allowed",
      checks: [
        {
          name: "permission",
          user: `user:${NODE_ID}/${USER_ID}`,
          relation: "can_read",
          object: `billing_account:${NODE_ID}/${ACCOUNT_ID}`,
          decision: "allow",
          code: "authz_allowed",
        },
      ],
    });
  });
});
