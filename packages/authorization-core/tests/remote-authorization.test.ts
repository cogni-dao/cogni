// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/authorization-core/tests/remote-authorization`
 * Purpose: Contract tests for the portable authorization-facade client.
 * Scope: Package-local tests with an injected fetch implementation only. Does not call network services.
 * Invariants: HTTPS_ONLY; STRICT_WIRE_VALIDATION; SAME_NODE_ONLY; ACCOUNT_MATCHES_TENANT; FAIL_CLOSED.
 * Side-effects: none
 * Links: task.5226, docs/spec/rbac.md
 * @internal
 */

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
const TOKEN = `cogni_naz_sk_v2_candidate-a_${NODE_ID}_${"a".repeat(64)}`;

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
      testOnlyFetchImpl: fetchImpl,
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
        redirect: "error",
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
      testOnlyFetchImpl: fetchImpl,
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
      testOnlyFetchImpl: fetchImpl,
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

  it.each([
    ["malformed", "not-a-principal"],
    ["empty", ""],
    ["wrong-kind", authzNodeAgentPrincipal(NODE_ID, AGENT_ID)],
    ["foreign", authzNodeUserPrincipal(OTHER_NODE_ID, USER_ID)],
  ])("denies a supplied %s OBO subject before transport", async (_case, subjectId) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const adapter = new RemoteAuthorizationAdapter({
      baseUrl: "https://operator.example",
      serviceToken: TOKEN,
      testOnlyFetchImpl: fetchImpl,
    });

    await expect(
      adapter.check({
        actorId: authzNodeAgentPrincipal(NODE_ID, AGENT_ID),
        subjectId,
        action: "billing_account.read",
        resource: authzBillingAccountResource(NODE_ID, ACCOUNT_ID),
        context: { tenantId: ACCOUNT_ID, nodeId: NODE_ID },
      })
    ).resolves.toMatchObject({ decision: "deny", code: "authz_denied" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("denies an account/RLS tenant mismatch before transport", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const adapter = new RemoteAuthorizationAdapter({
      baseUrl: "https://operator.example",
      serviceToken: TOKEN,
      testOnlyFetchImpl: fetchImpl,
    });

    await expect(
      adapter.check({
        actorId: authzNodeAgentPrincipal(NODE_ID, AGENT_ID),
        action: "billing_account.read",
        resource: authzBillingAccountResource(NODE_ID, ACCOUNT_ID),
        context: { tenantId: USER_ID, nodeId: NODE_ID },
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
      testOnlyFetchImpl: fetchImpl,
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
      testOnlyFetchImpl: fetchImpl,
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

  it("fails closed on malformed successful HTTP responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      json({ decision: "allow" })
    );
    const adapter = new RemoteAuthorizationAdapter({
      baseUrl: "https://operator.example",
      serviceToken: TOKEN,
      testOnlyFetchImpl: fetchImpl,
    });
    await expect(
      adapter.check({
        actorId: authzNodeUserPrincipal(NODE_ID, USER_ID),
        action: "billing_account.read",
        resource: authzBillingAccountResource(NODE_ID, ACCOUNT_ID),
        context: { tenantId: ACCOUNT_ID, nodeId: NODE_ID },
      })
    ).resolves.toMatchObject({
      decision: "deny",
      code: "authz_unavailable",
    });
  });

  it.each([
    "check",
    "bootstrap",
    "grant",
    "revoke",
  ] as const)("bounds %s when headers arrive but the body stalls", async (operation) => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({ cancel });
      const adapter = new RemoteAuthorizationAdapter({
        baseUrl: "https://operator.example",
        serviceToken: TOKEN,
        timeoutMs: 25,
        testOnlyFetchImpl: async () => new Response(stream),
      });
      const grant = {
        grantorUserId: USER_ID,
        billingAccountId: ACCOUNT_ID,
        target: { kind: "agent" as const, id: AGENT_ID },
        role: "tool_executor" as const,
        toolId: "core__sandbox_exec",
        expiresAt: "2026-11-01T00:00:00.000Z",
      };
      const result =
        operation === "check"
          ? adapter.check({
              actorId: authzNodeAgentPrincipal(NODE_ID, AGENT_ID),
              action: "tool.execute",
              resource: `tool:${NODE_ID}/${ACCOUNT_ID}/core__sandbox_exec`,
              context: { tenantId: ACCOUNT_ID, nodeId: NODE_ID },
            })
          : operation === "bootstrap"
            ? adapter.bootstrapBillingAccountOwner({
                ownerUserId: USER_ID,
                billingAccountId: ACCOUNT_ID,
              })
            : operation === "grant"
              ? adapter.grantBillingAccountAccess(grant)
              : adapter.revokeBillingAccountAccess(grant);
      await vi.advanceTimersByTimeAsync(25);
      await expect(result).resolves.toMatchObject({
        code:
          operation === "check"
            ? "authz_unavailable"
            : "authz_write_unavailable",
      });
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses an otherwise valid allow decision exceeding the body limit", async () => {
    const adapter = new RemoteAuthorizationAdapter({
      baseUrl: "https://operator.example",
      serviceToken: TOKEN,
      testOnlyFetchImpl: async () =>
        json({
          decision: "allow",
          code: "authz_allowed",
          checks: [
            {
              name: "permission",
              user: "x".repeat(65_537),
              relation: "can_read",
              object: "billing_account:oversized",
              decision: "allow",
              code: "authz_allowed",
            },
          ],
        }),
    });
    await expect(
      adapter.check({
        actorId: authzNodeUserPrincipal(NODE_ID, USER_ID),
        action: "billing_account.read",
        resource: authzBillingAccountResource(NODE_ID, ACCOUNT_ID),
        context: { tenantId: ACCOUNT_ID, nodeId: NODE_ID },
      })
    ).resolves.toMatchObject({
      decision: "deny",
      code: "authz_unavailable",
      reason: "authorization facade response too large",
    });
  });

  it("requires HTTPS unless an explicit test transport is injected", () => {
    expect(
      () =>
        new RemoteAuthorizationAdapter({
          baseUrl: "http://operator.example",
          serviceToken: TOKEN,
        })
    ).toThrow("authorization facade requires HTTPS");
    expect(
      () =>
        new RemoteAuthorizationAdapter({
          baseUrl: "http://operator.test",
          serviceToken: TOKEN,
          testOnlyFetchImpl: vi.fn<typeof fetch>(),
        })
    ).not.toThrow();
  });
});
