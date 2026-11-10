// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/agent.credentials.renew-v1`
 * Purpose: Contract test for POST /api/v1/agent/credentials/renew-v1 (task.5475,
 *   C1-C2): a valid v1 key renews to a fresh key for the same sub; session
 *   callers and wallet users are refused; the hard stop (env may only shorten)
 *   is enforced.
 * Scope: Real HMAC resolver + issueAgentApiKey; mocks env, next/headers,
 *   session getter, container and the users read.
 * Links: src/app/api/v1/agent/credentials/renew-v1/route.ts
 * @public
 */

import { TEST_USER_ID_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

const env: { AUTH_SECRET: string; AGENT_V1_HARD_STOP?: string } = {
  AUTH_SECRET: "test-auth-secret-for-unit-tests",
};
vi.mock("@/shared/env/server", () => ({ serverEnv: () => env }));
vi.mock("@/shared/config", () => ({ getNodeId: () => "test-node-id" }));

const mockHeaders = vi.fn();
vi.mock("next/headers", () => ({
  headers: (...args: unknown[]) => mockHeaders(...args),
}));

const mockGetServerSessionUser = vi.fn();
vi.mock("@/lib/auth/server", () => ({
  getServerSessionUser: (...args: unknown[]) =>
    mockGetServerSessionUser(...args),
}));

const mockLimit = vi.fn();
vi.mock("@/bootstrap/container", () => ({
  resolveServiceDb: () => ({
    select: () => ({
      from: () => ({ where: () => ({ limit: mockLimit }) }),
    }),
  }),
  getContainer: vi.fn(() => ({
    config: { unhandledErrorPolicy: "rethrow" },
    log: {
      child: vi.fn().mockReturnThis(),
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
    clock: { now: () => new Date("2026-11-10T00:00:00.000Z") },
  })),
}));

import { issueAgentApiKey } from "@/app/_lib/auth/request-identity";
import * as appHandler from "@/app/api/v1/agent/credentials/renew-v1/route";

const bearer = (token: string) => ({
  get: (n: string) =>
    n.toLowerCase() === "authorization" ? `Bearer ${token}` : null,
});
const OLD_KEY = issueAgentApiKey({
  userId: TEST_USER_ID_1,
  displayName: "agent",
});
const DEFAULT_STOP = "2027-01-31T00:00:00.000Z";

async function renew(token?: string) {
  mockHeaders.mockResolvedValue(token ? bearer(token) : { get: () => null });
  let out: { status: number; json: Record<string, string> } | undefined;
  await testApiHandler({
    appHandler,
    url: "/api/v1/agent/credentials/renew-v1",
    async test({ fetch }) {
      const res = await fetch({ method: "POST" });
      out = { status: res.status, json: await res.json() };
    },
  });
  return out as NonNullable<typeof out>;
}

describe("POST /api/v1/agent/credentials/renew-v1", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    env.AGENT_V1_HARD_STOP = undefined;
    mockLimit.mockResolvedValue([{ walletAddress: null }]);
    mockGetServerSessionUser.mockResolvedValue(null);
  });

  it("mints a new key for the same sub that authenticates (200)", async () => {
    const first = await renew(OLD_KEY);
    expect(first.status).toBe(200);
    expect(first.json.userId).toBe(TEST_USER_ID_1);
    expect(first.json.apiKey).toContain("cogni_ag_sk_v1_");
    expect(first.json.hardStop).toBe(DEFAULT_STOP);
    // The renewed key is itself valid and renews again (same sub).
    const second = await renew(first.json.apiKey);
    expect(second.status).toBe(200);
    expect(second.json.userId).toBe(TEST_USER_ID_1);
  });

  it("refuses a session (cookie) caller with 403", async () => {
    mockGetServerSessionUser.mockResolvedValue({
      id: TEST_USER_ID_1,
      walletAddress: "0xabc",
      displayName: null,
      avatarColor: null,
    });
    const res = await renew();
    expect(res.status).toBe(403);
    expect(res.json.error).toBe("agent_key_required");
  });

  it("refuses a wallet user even with a v1 key", async () => {
    mockLimit.mockResolvedValue([{ walletAddress: "0xabc" }]);
    const res = await renew(OLD_KEY);
    expect(res.status).toBe(403);
    expect(res.json.error).toBe("wallet_user_refused");
  });

  it("returns 403 v1_hard_stop once the env hard stop is in the past", async () => {
    env.AGENT_V1_HARD_STOP = "2020-01-01T00:00:00Z";
    const res = await renew(OLD_KEY);
    expect(res.status).toBe(403);
    expect(res.json.error).toBe("v1_hard_stop");
  });

  it("clamps an env hard stop later than the code default (C1)", async () => {
    env.AGENT_V1_HARD_STOP = "2030-01-01T00:00:00Z";
    const res = await renew(OLD_KEY);
    expect(res.status).toBe(200);
    expect(res.json.hardStop).toBe(DEFAULT_STOP);
  });

  it("honors an env hard stop earlier than the default and caps the key expiry", async () => {
    const soon = new Date(Date.now() + 5 * 24 * 3600 * 1000);
    env.AGENT_V1_HARD_STOP = soon.toISOString();
    const res = await renew(OLD_KEY);
    expect(res.status).toBe(200);
    expect(new Date(res.json.expiresAt).getTime()).toBeLessThanOrEqual(
      soon.getTime()
    );
  });

  it("disables the route (503) on an unparsable env value", async () => {
    env.AGENT_V1_HARD_STOP = "not-a-date";
    const res = await renew(OLD_KEY);
    expect(res.status).toBe(503);
  });
});
