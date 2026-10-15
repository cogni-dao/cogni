// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Exact durable-principal proof for GET /api/v1/agent/me (task.5252). */
import { agentMeV2Operation } from "@cogni/node-contracts";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

const NODE_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const CREDENTIAL_ID = "33333333-3333-4333-8333-333333333333";
const BILLING_ID = "44444444-4444-4444-8444-444444444444";
const PRINCIPAL_ID = `agent:${NODE_ID}/${ACTOR_ID}`;

const authenticate = vi.hoisted(() => vi.fn());
const listRelations = vi.hoisted(() => vi.fn());
const resolvePrincipal = vi.hoisted(() => vi.fn());
const mockLog = vi.hoisted(() => ({
  child: vi.fn().mockReturnThis(),
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    log: mockLog,
    clock: { now: () => new Date("2026-10-14T00:00:00Z") },
    config: { unhandledErrorPolicy: "rethrow" },
    agentIdentity: { authenticate },
    authorization: { listRelations },
  }),
}));

vi.mock("@/bootstrap/otel", () => ({
  withRootSpan: async (
    _name: string,
    _attrs: Record<string, string>,
    handler: (ctx: {
      traceId: string;
      span: { setAttribute: () => void };
    }) => Promise<unknown>
  ) => handler({ traceId: "trace-1", span: { setAttribute: vi.fn() } }),
}));

vi.mock("@/app/_lib/auth/request-identity", () => ({
  RequestIdentityUnavailableError: class RequestIdentityUnavailableError extends Error {},
  resolveRequestPrincipal: resolvePrincipal,
  extractBearerToken: (header: string | null) =>
    header?.startsWith("Bearer ") ? header.slice(7) : null,
}));

vi.mock("@/shared/observability", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/shared/observability")>();
  return {
    ...actual,
    createRequestContext: () => ({
      log: mockLog,
      reqId: "req-1",
      routeId: "agent.me.read",
    }),
    logRequestEnd: vi.fn(),
    logRequestStart: vi.fn(),
  };
});

import * as appHandler from "@/app/api/v1/agent/me/route";

describe("GET /api/v1/agent/me", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolvePrincipal.mockResolvedValue(null);
    authenticate.mockResolvedValue({
      principal: {
        kind: "agent",
        principalId: PRINCIPAL_ID,
        actorId: ACTOR_ID,
        credentialId: CREDENTIAL_ID,
        billingAccountId: BILLING_ID,
        displayName: "flock-leader",
        legacyUserId: null,
      },
      access: "active",
      authenticateUntil: "2026-11-14T00:00:00.000Z",
      renewUntil: "2026-11-21T00:00:00.000Z",
    });
    listRelations.mockResolvedValue({
      decision: "success",
      code: "authz_list_success",
      tuples: [
        {
          user: PRINCIPAL_ID,
          relation: "developer",
          object: `node:${NODE_ID}`,
        },
      ],
    });
  });

  it("returns the actor principal and reads grants for that exact subject", async () => {
    await testApiHandler({
      appHandler,
      async test({ fetch }) {
        const response = await fetch({
          headers: {
            Authorization: `Bearer cogni_ag_sk_v2_${CREDENTIAL_ID}.secret`,
          },
        });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(agentMeV2Operation.output.safeParse(body).success).toBe(true);
        expect(body.identity.principalId).toBe(PRINCIPAL_ID);
        expect(body.identity.credentialId).toBe(CREDENTIAL_ID);
        expect(body.nodes).toEqual([{ nodeId: NODE_ID, roles: ["developer"] }]);
        expect(listRelations).toHaveBeenCalledWith(PRINCIPAL_ID);
        expect(listRelations).toHaveBeenCalledTimes(1);
      },
    });
  });

  it("reports a browser session as human without an agent credential", async () => {
    const userId = "55555555-5555-4555-8555-555555555555";
    resolvePrincipal.mockResolvedValue({
      kind: "human",
      principalId: `user:${NODE_ID}/${userId}`,
      userId,
      walletAddress: "0x1111111111111111111111111111111111111111",
      displayName: "Human steward",
      avatarColor: null,
    });

    await testApiHandler({
      appHandler,
      async test({ fetch }) {
        const response = await fetch();
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(agentMeV2Operation.output.safeParse(body).success).toBe(true);
        expect(body).toMatchObject({
          kind: "human",
          identity: { principalId: `user:${NODE_ID}/${userId}`, userId },
          credential: null,
        });
      },
    });
  });

  it("reports a v1 bearer as legacy_agent, never human", async () => {
    const legacyUserId = "66666666-6666-4666-8666-666666666666";
    resolvePrincipal.mockResolvedValue({
      kind: "legacy_agent",
      principalId: `user:${NODE_ID}/${legacyUserId}`,
      legacyUserId,
      displayName: "Legacy machine",
      expiresAt: "2026-11-14T00:00:00.000Z",
    });

    await testApiHandler({
      appHandler,
      async test({ fetch }) {
        const response = await fetch({
          headers: { Authorization: "Bearer cogni_ag_sk_v1_legacy-token" },
        });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(agentMeV2Operation.output.safeParse(body).success).toBe(true);
        expect(body).toMatchObject({
          kind: "legacy_agent",
          identity: {
            principalId: `user:${NODE_ID}/${legacyUserId}`,
            legacyUserId,
          },
          credential: { kind: "legacy_v1", status: "active" },
        });
      },
    });
  });
});
