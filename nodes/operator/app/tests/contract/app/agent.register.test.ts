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
  billingAccountId: "billing-1",
  authenticateUntil: "2026-01-31T00:00:00.000Z",
  renewUntil: "2026-02-07T00:00:00.000Z",
});

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
      agentIdentity: { redeemSpawnGrant: mockRedeem },
    })),
  };
});

import * as appHandler from "@/app/api/v1/agent/register/route";

describe("POST /api/v1/agent/register", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 201 with actor credentials", async () => {
    await testApiHandler({
      appHandler,
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
        expect(json.billingAccountId).toBe("billing-1");
        expect(mockRedeem).toHaveBeenCalledWith(
          "cogni_ag_sg_v1_abcdefghijklmnopqrstuvwxyz0123456789"
        );
      },
    });
  });

  it("returns 400 for invalid payload", async () => {
    await testApiHandler({
      appHandler,
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
