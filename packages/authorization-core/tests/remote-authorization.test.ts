// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it, vi } from "vitest";

import {
  authorizationFacadeNodeIdFromToken,
  authzBillingAccountResource,
  authzNodeAgentPrincipal,
  authzNodeUserPrincipal,
  RemoteAuthorizationAdapter,
} from "../src/index";

const NODE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_NODE_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_ID = "44444444-4444-4444-8444-444444444444";
const ACCOUNT_ID = "55555555-5555-4555-8555-555555555555";
const TOKEN = `cogni_naz_sk_v1_${NODE_ID}_${"a".repeat(64)}`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("authorizationFacadeNodeIdFromToken", () => {
  it("derives the canonical node UUID and rejects malformed credentials", () => {
    expect(authorizationFacadeNodeIdFromToken(TOKEN)).toBe(NODE_ID);
    expect(() =>
      authorizationFacadeNodeIdFromToken(`cogni_naz_sk_v1_${NODE_ID}_short`)
    ).toThrow("invalid authorization facade service credential");
  });
});

describe("RemoteAuthorizationAdapter", () => {
  it("sends local IDs for a direct same-node account read", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        actor: { kind: "user", id: USER_ID },
        billingAccountId: ACCOUNT_ID,
        context: { runId: "run-1" },
      });
      return json({ decision: "allow", code: "authz_allowed", checks: [] });
    });
    const adapter = new RemoteAuthorizationAdapter({
      baseUrl: "https://operator.example",
      serviceToken: TOKEN,
      fetchImpl,
    });

    await expect(
      adapter.check({
        actorId: authzNodeUserPrincipal(NODE_ID, USER_ID),
        action: "billing_account.read",
        resource: authzBillingAccountResource(NODE_ID, ACCOUNT_ID),
        context: { tenantId: ACCOUNT_ID, nodeId: NODE_ID, runId: "run-1" },
      })
    ).resolves.toMatchObject({ decision: "allow", code: "authz_allowed" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://operator.example/api/v1/authorization/check",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: `Bearer ${TOKEN}` }),
      })
    );
  });

  it("carries agent, subject, and exact account for a three-leg OBO check", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        actor: { kind: "agent", id: AGENT_ID },
        subjectUserId: USER_ID,
        billingAccountId: ACCOUNT_ID,
      });
      return json({ decision: "allow", code: "authz_allowed", checks: [] });
    });
    const adapter = new RemoteAuthorizationAdapter({
      baseUrl: "https://operator.example/",
      serviceToken: TOKEN,
      fetchImpl,
    });

    await adapter.check({
      actorId: authzNodeAgentPrincipal(NODE_ID, AGENT_ID),
      subjectId: authzNodeUserPrincipal(NODE_ID, USER_ID),
      action: "billing_account.read",
      resource: authzBillingAccountResource(NODE_ID, ACCOUNT_ID),
      context: { tenantId: ACCOUNT_ID, nodeId: NODE_ID },
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("denies foreign namespaces locally without contacting the facade", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const adapter = new RemoteAuthorizationAdapter({
      baseUrl: "https://operator.example",
      serviceToken: TOKEN,
      fetchImpl,
    });

    await expect(
      adapter.check({
        actorId: authzNodeAgentPrincipal(OTHER_NODE_ID, AGENT_ID),
        action: "billing_account.read",
        resource: authzBillingAccountResource(NODE_ID, ACCOUNT_ID),
        context: { tenantId: ACCOUNT_ID, nodeId: NODE_ID },
      })
    ).resolves.toMatchObject({ decision: "deny", code: "authz_denied" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("exposes only semantic grant fields and preserves denied vs unavailable", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return json({ error: "authz_denied" }, 403);
    });
    const adapter = new RemoteAuthorizationAdapter({
      baseUrl: "https://operator.example",
      serviceToken: TOKEN,
      fetchImpl,
    });

    await expect(
      adapter.grantBillingAccountAccess({
        grantorUserId: USER_ID,
        billingAccountId: ACCOUNT_ID,
        target: { kind: "agent", id: AGENT_ID },
        role: "obo",
        subjectUserId: USER_ID,
        expiresAt: "2026-11-01T00:00:00.000Z",
      })
    ).resolves.toMatchObject({
      decision: "failure",
      code: "authz_write_denied",
    });
    expect(bodies[0]).toEqual({
      operation: "grant",
      grantorUserId: USER_ID,
      billingAccountId: ACCOUNT_ID,
      target: { kind: "agent", id: AGENT_ID },
      role: "obo",
      subjectUserId: USER_ID,
      expiresAt: "2026-11-01T00:00:00.000Z",
    });
    expect(JSON.stringify(bodies[0])).not.toMatch(/relation|object|nodeId/);
  });

  it("rejects malformed local mutation IDs before transport", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const adapter = new RemoteAuthorizationAdapter({
      baseUrl: "https://operator.example",
      serviceToken: TOKEN,
      fetchImpl,
    });
    await expect(
      adapter.grantBillingAccountAccess({
        grantorUserId: USER_ID,
        billingAccountId: ACCOUNT_ID,
        target: {
          kind: "agent",
          id: authzNodeAgentPrincipal(OTHER_NODE_ID, AGENT_ID),
        },
        role: "obo",
        subjectUserId: USER_ID,
        expiresAt: "2026-11-01T00:00:00.000Z",
      })
    ).resolves.toMatchObject({
      decision: "failure",
      code: "authz_write_denied",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
