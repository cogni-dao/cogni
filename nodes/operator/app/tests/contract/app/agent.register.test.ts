// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/agent.register`
 * Purpose: Contract test for POST /api/v1/agent/register — validates the
 *   wrapped, instrumented registration handler. Container mock matches the
 *   shape wrapRouteHandlerWithLogging reads (log.child, clock.now, config).
 * Scope: Mocks only infrastructure leaves (DB, container, token issuer).
 *   Does NOT mock any auth resolver — the route runs in auth mode "none".
 * Links: src/app/api/v1/agent/register/route.ts
 * @public
 */

import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The service-role postgres.js client: `begin` runs the callback with a tag that records each statement.
const sqlStatements: string[] = [];
const mockTx = vi.fn(async (strings: TemplateStringsArray) => {
  sqlStatements.push(strings.join("?"));
  return [];
});
const mockBegin = vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) =>
  fn(mockTx)
);

const mockGetOrCreate = vi.fn().mockResolvedValue({ id: "billing-1" });

vi.mock("@/app/_lib/auth/request-identity", () => ({
  issueAgentApiKey: vi.fn(() => "cogni_ag_sk_v1_test"),
}));

// Container shape must satisfy both the route body (resolveServiceDb,
// serviceAccountService.getOrCreateBillingAccountForUser) AND the
// wrapRouteHandlerWithLogging envelope (log.child, clock.now, config).
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
    resolveServiceDb: vi.fn(() => ({ $client: { begin: mockBegin } })),
    getContainer: vi.fn(() => ({
      log,
      clock: { now: vi.fn(() => new Date("2026-01-01T00:00:00Z")) },
      config: { unhandledErrorPolicy: "rethrow" },
      serviceAccountService: {
        getOrCreateBillingAccountForUser: mockGetOrCreate,
      },
    })),
  };
});

import * as appHandler from "@/app/api/v1/agent/register/route";

describe("POST /api/v1/agent/register", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlStatements.length = 0;
  });

  it("returns 201 with actor credentials", async () => {
    await testApiHandler({
      appHandler,
      url: "/api/v1/agent/register",
      async test({ fetch }) {
        const response = await fetch({
          method: "POST",
          body: JSON.stringify({ name: "test-agent" }),
          headers: { "content-type": "application/json" },
        });

        expect(response.status).toBe(201);
        const json = await response.json();
        // actorId is intentionally absent: v0 has no actors table, so the
        // register contract returns only userId. Clients derive actor
        // identity from userId until bug.0297 lands the actors schema.
        expect(json.actorId).toBeUndefined();
        expect(json.userId).toBeTypeOf("string");
        expect(json.apiKey).toContain("cogni_ag_sk_v1_");
        expect(json.billingAccountId).toBe("billing-1");
        // The user row and its external principal row are written in ONE transaction.
        expect(mockBegin).toHaveBeenCalledTimes(1);
        expect(sqlStatements).toHaveLength(2);
        expect(sqlStatements[0]).toContain("INSERT INTO users");
        expect(sqlStatements[1]).toContain("INSERT INTO agent_principals");
        expect(sqlStatements[1]).toContain("'external'");
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
          body: JSON.stringify({ name: "" }),
          headers: { "content-type": "application/json" },
        });

        expect(response.status).toBe(400);
      },
    });
  });
});
