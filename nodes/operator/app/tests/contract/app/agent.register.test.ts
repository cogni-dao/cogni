// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/agent.register`
 * Purpose: Contract test for POST /api/v1/agent/register — validates the
 *   wrapped, instrumented registration handler. Container mock matches the
 *   shape wrapRouteHandlerWithLogging reads (log.child, clock.now, config).
 * Scope: Mocks only the durable agent-identity port exposed by the container.
 *   Does NOT mock any auth resolver — the route runs in auth mode "none".
 * Links: src/app/api/v1/agent/register/route.ts
 * @public
 */

import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFeatureWarn = vi.hoisted(() => vi.fn());

const mockRedeem = vi.fn().mockResolvedValue({
  actorId: "11111111-1111-4111-8111-111111111111",
  principalId:
    "agent:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/11111111-1111-4111-8111-111111111111",
  credentialId: "22222222-2222-4222-8222-222222222222",
  apiKey: "cogni_ag_sk_v2_22222222-2222-4222-8222-222222222222.secret",
  billingAccountId: "44444444-4444-4444-8444-444444444444",
  authenticateUntil: "2026-01-31T00:00:00.000Z",
  renewUntil: "2026-02-07T00:00:00.000Z",
});
const upgraded = {
  actorId: "11111111-1111-4111-8111-111111111111",
  principalId:
    "agent:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/11111111-1111-4111-8111-111111111111",
  credentialId: "22222222-2222-4222-8222-222222222222",
  apiKey: "cogni_ag_sk_v2_22222222-2222-4222-8222-222222222222.secret",
  billingAccountId: "44444444-4444-4444-8444-444444444444",
  authenticateUntil: "2026-01-31T00:00:00.000Z",
  renewUntil: "2026-02-07T00:00:00.000Z",
};
const mockUpgrade = vi.fn().mockResolvedValue(upgraded);
const mockRecover = vi.fn().mockResolvedValue(upgraded);
const mockListRelations = vi.fn().mockResolvedValue({
  decision: "success",
  tuples: [
    {
      user: "user:legacy-user",
      relation: "developer",
      object: "node:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    },
  ],
});
const mockWriteRelation = vi.fn().mockResolvedValue({ decision: "success" });
let authorization:
  | {
      listRelations: typeof mockListRelations;
      writeRelation: typeof mockWriteRelation;
    }
  | undefined;

vi.mock("@/app/_lib/auth/request-identity", () => ({
  extractBearerToken: vi.fn((header: string | null) =>
    header?.startsWith("Bearer ") ? header.slice(7) : null
  ),
  verifyLegacyAgentApiKey: vi.fn(() => ({
    sub: "legacy-user",
    displayName: "Legacy agent",
    iat: 1,
    exp: 4_102_444_800,
  })),
}));

vi.mock("@/shared/config", () => ({
  getNodeId: vi.fn(() => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
}));

// Container shape must satisfy the route body and logging envelope.
vi.mock("@/bootstrap/container", () => {
  const childLogger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: mockFeatureWarn,
    debug: vi.fn(),
  };
  const log = {
    child: vi.fn(() => childLogger),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
  return {
    getContainer: vi.fn(() => ({
      log,
      clock: { now: vi.fn(() => new Date("2026-01-01T00:00:00Z")) },
      config: { unhandledErrorPolicy: "rethrow" },
      agentIdentity: {
        redeemSpawnGrant: mockRedeem,
        recover: mockRecover,
        upgradeLegacy: mockUpgrade,
      },
      authorization,
    })),
  };
});

import * as recoverHandler from "@/app/api/v1/agent/recover/route";
import * as registerHandler from "@/app/api/v1/agent/register/route";
import * as upgradeHandler from "@/app/api/v1/agent/upgrade/route";
import { agentIdentityApiLimiter } from "@/bootstrap/http";
import { AgentIdentityError } from "@/ports";

describe("POST /api/v1/agent/register", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(agentIdentityApiLimiter, "consume").mockReturnValue(true);
    authorization = {
      listRelations: mockListRelations,
      writeRelation: mockWriteRelation,
    };
    mockListRelations.mockResolvedValue({
      decision: "success",
      tuples: [
        {
          user: "user:legacy-user",
          relation: "developer",
          object: "node:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        },
      ],
    });
    mockWriteRelation.mockResolvedValue({ decision: "success" });
  });

  it("returns 201 with actor credentials", async () => {
    await testApiHandler({
      appHandler: registerHandler,
      url: "/api/v1/agent/register",
      async test({ fetch }) {
        const response = await fetch({
          method: "POST",
          body: JSON.stringify({
            spawnToken: "cogni_ag_sg_v1_abcdefghijklmnopqrstuvwxyz0123456789",
          }),
          headers: { "content-type": "application/json" },
        });

        expect(response.status).toBe(201);
        const json = await response.json();
        expect(json.actorId).toBe("11111111-1111-4111-8111-111111111111");
        expect(json.principalId).toBe(
          "agent:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/11111111-1111-4111-8111-111111111111"
        );
        expect(json.apiKey).toContain("cogni_ag_sk_v2_");
        expect(json.billingAccountId).toBe(
          "44444444-4444-4444-8444-444444444444"
        );
        expect(mockRedeem).toHaveBeenCalledWith(
          "cogni_ag_sg_v1_abcdefghijklmnopqrstuvwxyz0123456789"
        );
      },
    });
  });

  it("returns 400 for invalid payload", async () => {
    await testApiHandler({
      appHandler: registerHandler,
      url: "/api/v1/agent/register",
      async test({ fetch }) {
        const response = await fetch({
          method: "POST",
          body: JSON.stringify({ spawnToken: "" }),
          headers: { "content-type": "application/json" },
        });

        expect(response.status).toBe(400);
        expect(mockRedeem).not.toHaveBeenCalled();
      },
    });
  });

  it("returns 409 without secret material when an expired redeemed grant is replayed", async () => {
    mockRedeem.mockRejectedValueOnce(
      new AgentIdentityError(
        "grant_already_redeemed",
        "Spawn grant was redeemed; use credential recovery"
      )
    );
    await testApiHandler({
      appHandler: registerHandler,
      url: "/api/v1/agent/register",
      async test({ fetch }) {
        const response = await fetch({
          method: "POST",
          body: JSON.stringify({
            spawnToken: "cogni_ag_sg_v1_abcdefghijklmnopqrstuvwxyz0123456789",
          }),
          headers: { "content-type": "application/json" },
        });

        expect(response.status).toBe(409);
        const body = await response.json();
        expect(body).toEqual({
          error: "grant_already_redeemed",
          error_description:
            "Spawn grant was redeemed; use credential recovery",
        });
        expect(body).not.toHaveProperty("apiKey");
        expect(mockFeatureWarn).toHaveBeenCalledTimes(1);
        expect(mockFeatureWarn.mock.calls[0]?.[0]).toMatchObject({
          operation: "register",
          statusCode: 409,
          errorCode: "http_409",
          reasonCode: "grant_already_redeemed",
        });
        expect(JSON.stringify(mockFeatureWarn.mock.calls[0]?.[0])).not.toMatch(
          /apiKey|spawnToken|credentialId|actorId|userId/
        );
      },
    });
  });

  it("rate-limits registration work before grant redemption", async () => {
    vi.spyOn(agentIdentityApiLimiter, "consume").mockReturnValueOnce(false);
    await testApiHandler({
      appHandler: registerHandler,
      url: "/api/v1/agent/register",
      async test({ fetch }) {
        const response = await fetch({
          method: "POST",
          body: JSON.stringify({
            spawnToken: "cogni_ag_sg_v1_abcdefghijklmnopqrstuvwxyz0123456789",
          }),
          headers: {
            "content-type": "application/json",
            "x-real-ip": "192.0.2.41",
          },
        });

        expect(response.status).toBe(429);
        await expect(response.json()).resolves.toEqual({
          error: "rate_limited",
        });
        expect(mockRedeem).not.toHaveBeenCalled();
        expect(mockFeatureWarn).toHaveBeenCalledTimes(1);
        expect(mockFeatureWarn.mock.calls[0]?.[0]).toMatchObject({
          operation: "register",
          statusCode: 429,
          reasonCode: "rate_limited",
        });
      },
    });
  });
});

describe("POST /api/v1/agent/recover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(agentIdentityApiLimiter, "consume").mockReturnValue(true);
  });

  it("returns 409 without secret material when an expired redeemed grant is replayed", async () => {
    mockRecover.mockRejectedValueOnce(
      new AgentIdentityError(
        "grant_already_redeemed",
        "Recovery grant was redeemed; request a new recovery grant"
      )
    );
    await testApiHandler({
      appHandler: recoverHandler,
      url: "/api/v1/agent/recover",
      async test({ fetch }) {
        const response = await fetch({
          method: "POST",
          body: JSON.stringify({
            recoveryToken:
              "cogni_ag_rg_v1_abcdefghijklmnopqrstuvwxyz0123456789",
          }),
          headers: { "content-type": "application/json" },
        });

        expect(response.status).toBe(409);
        const body = await response.json();
        expect(body).toEqual({
          error: "grant_already_redeemed",
          error_description:
            "Recovery grant was redeemed; request a new recovery grant",
        });
        expect(body).not.toHaveProperty("apiKey");
        expect(mockFeatureWarn).toHaveBeenCalledTimes(1);
        expect(mockFeatureWarn.mock.calls[0]?.[0]).toMatchObject({
          operation: "recover",
          statusCode: 409,
          reasonCode: "grant_already_redeemed",
        });
      },
    });
  });
});

function upgradeRequest(fetch: (init?: RequestInit) => Promise<Response>) {
  return fetch({
    method: "POST",
    headers: {
      authorization: "Bearer cogni_ag_sk_v1_signed-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ idempotencyKey: "upgrade-retry-1" }),
  });
}

describe("POST /api/v1/agent/upgrade", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(agentIdentityApiLimiter, "consume").mockReturnValue(true);
    authorization = {
      listRelations: mockListRelations,
      writeRelation: mockWriteRelation,
    };
    mockListRelations.mockResolvedValue({
      decision: "success",
      tuples: [
        {
          user: "user:legacy-user",
          relation: "developer",
          object: "node:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        },
      ],
    });
    mockWriteRelation.mockResolvedValue({ decision: "success" });
  });

  it("fails before creating upgrade material when authorization is absent", async () => {
    authorization = undefined;
    await testApiHandler({
      appHandler: upgradeHandler,
      url: "/api/v1/agent/upgrade",
      async test({ fetch }) {
        const response = await upgradeRequest(fetch);
        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toEqual({
          error: "authz_unavailable",
        });
        expect(mockUpgrade).not.toHaveBeenCalled();
        expect(mockFeatureWarn).toHaveBeenCalledTimes(1);
        expect(mockFeatureWarn.mock.calls[0]?.[0]).toMatchObject({
          operation: "upgrade",
          statusCode: 503,
          reasonCode: "authz_unavailable",
        });
      },
    });
  });

  it("fails closed when source grants cannot be listed", async () => {
    mockListRelations.mockResolvedValueOnce({
      decision: "authz_unavailable",
      reason: "openfga unavailable",
      tuples: [],
    });
    await testApiHandler({
      appHandler: upgradeHandler,
      url: "/api/v1/agent/upgrade",
      async test({ fetch }) {
        const response = await upgradeRequest(fetch);
        expect(response.status).toBe(503);
        expect(mockWriteRelation).not.toHaveBeenCalled();
      },
    });
  });

  it("migrates only explicit agent-safe direct node roles", async () => {
    mockListRelations.mockResolvedValue({
      decision: "success",
      tuples: [
        {
          user: "user:legacy-user",
          relation: "developer",
          object: "node:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        },
        {
          user: "user:legacy-user",
          relation: "admin",
          object: "node:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        },
        {
          user: "user:legacy-user",
          relation: "developer",
          object: "repository:cogni-dao/cogni",
        },
        {
          user: "user:legacy-user",
          relation: "developer",
          object: "node:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        },
      ],
    });

    await testApiHandler({
      appHandler: upgradeHandler,
      url: "/api/v1/agent/upgrade",
      async test({ fetch }) {
        const response = await upgradeRequest(fetch);
        expect(response.status).toBe(201);
        expect(mockWriteRelation).toHaveBeenCalledTimes(2);
        expect(mockWriteRelation).toHaveBeenNthCalledWith(1, {
          user: upgraded.principalId,
          relation: "developer",
          object: "node:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        });
        expect(mockWriteRelation).toHaveBeenNthCalledWith(2, {
          user: upgraded.principalId,
          relation: "developer",
          object: "node:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        });
      },
    });
  });

  it("returns the same material on retry only after grant copy succeeds", async () => {
    mockWriteRelation
      .mockResolvedValueOnce({
        decision: "failure",
        code: "authz_write_unavailable",
      })
      .mockResolvedValue({ decision: "success" });

    await testApiHandler({
      appHandler: upgradeHandler,
      url: "/api/v1/agent/upgrade",
      async test({ fetch }) {
        const first = await upgradeRequest(fetch);
        expect(first.status).toBe(503);
        const firstBody = await first.json();
        expect(firstBody).toEqual({
          error: "authz_unavailable",
        });
        expect(firstBody).not.toHaveProperty("apiKey");

        const retry = await upgradeRequest(fetch);
        expect(retry.status).toBe(201);
        await expect(retry.json()).resolves.toEqual(upgraded);
        expect(mockUpgrade).toHaveBeenCalledTimes(2);
        expect(mockUpgrade.mock.calls[0]).toEqual(mockUpgrade.mock.calls[1]);
        expect(mockListRelations.mock.calls.map(([source]) => source)).toEqual([
          "user:legacy-user",
          "user:legacy-user",
          "user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/legacy-user",
        ]);
        expect(mockWriteRelation).toHaveBeenCalledTimes(3);
        expect(mockWriteRelation).toHaveBeenLastCalledWith({
          user: upgraded.principalId,
          relation: "developer",
          object: "node:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        });
      },
    });
  });
});
