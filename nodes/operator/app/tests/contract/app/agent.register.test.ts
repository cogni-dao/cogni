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
    warn: vi.fn(),
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
        upgradeLegacy: mockUpgrade,
      },
      authorization,
    })),
  };
});

import * as registerHandler from "@/app/api/v1/agent/register/route";
import * as upgradeHandler from "@/app/api/v1/agent/upgrade/route";

describe("POST /api/v1/agent/register", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("returns the same material on retry only after grant copy succeeds", async () => {
    await testApiHandler({
      appHandler: upgradeHandler,
      url: "/api/v1/agent/upgrade",
      async test({ fetch }) {
        const first = await upgradeRequest(fetch);
        const retry = await upgradeRequest(fetch);
        expect(first.status).toBe(201);
        expect(retry.status).toBe(201);
        await expect(first.json()).resolves.toEqual(upgraded);
        await expect(retry.json()).resolves.toEqual(upgraded);
        expect(mockUpgrade).toHaveBeenCalledTimes(2);
        expect(mockWriteRelation).toHaveBeenCalledTimes(4);
      },
    });
  });
});
