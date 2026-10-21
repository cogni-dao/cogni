// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/agent.runs.list`
 * Purpose: Contract test for GET /api/v1/agent/runs exercising the real
 *   resolveRequestIdentity chain end-to-end. Mocks only the leaf
 *   getServerSessionUser, serverEnv, next/headers, and the container —
 *   NOT resolveRequestIdentity itself. This placement catches the
 *   circular-re-export OOM class of bug at contract-test time.
 * Scope: Routes the request through the real token codec + resolver so
 *   that any regression (resolver skipped, mocks hiding broken code,
 *   recursion re-introduced) blows up here instead of in prod.
 * Side-effects: none (all IO mocked at the leaves).
 * Links: src/app/api/v1/agent/runs/route.ts, src/app/_lib/auth/request-identity.ts
 * @public
 */

import type { GraphRun } from "@cogni/scheduler-core";
import { TEST_SESSION_USER_1, TEST_USER_ID_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mocks at the resolver's leaves (NOT the resolver itself) ───
vi.mock("@/shared/env/server", () => ({
  serverEnv: () => ({ AUTH_SECRET: "test-auth-secret-for-unit-tests" }),
}));

vi.mock("@/shared/config", () => ({
  getNodeId: () => "test-node-id",
}));

const mockHeaders = vi.fn();
vi.mock("next/headers", () => ({
  headers: (...args: unknown[]) => mockHeaders(...args),
}));

const mockGetServerSessionUser = vi.fn();
vi.mock("@/lib/auth/server", () => ({
  getServerSessionUser: (...args: unknown[]) =>
    mockGetServerSessionUser(...args),
}));

// Import AFTER env mock so issueAgentApiKey reads the test secret.
import { issueAgentApiKey } from "@/app/_lib/auth/request-identity";
import * as appHandler from "@/app/api/v1/agent/runs/route";

const mockListRunsByUser = vi.fn();
vi.mock("@/bootstrap/container", () => ({
  getContainer: vi.fn(() => ({
    log: {
      child: vi.fn(() => ({
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      })),
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
    clock: { now: vi.fn(() => new Date("2025-01-01T00:00:00Z")) },
    config: { unhandledErrorPolicy: "rethrow" },
    graphRunRepository: {
      listRunsByUser: mockListRunsByUser,
    },
  })),
}));

function headersFromRecord(record: Record<string, string>) {
  const normalized = new Map(
    Object.entries(record).map(([k, v]) => [k.toLowerCase(), v])
  );
  return { get: (name: string) => normalized.get(name.toLowerCase()) ?? null };
}

function makeRun(overrides: Partial<GraphRun> = {}): GraphRun {
  return {
    id: "pk-1",
    scheduleId: null,
    runId: "run-1",
    graphId: "langgraph:default",
    runKind: "user_immediate",
    triggerSource: "api",
    triggerRef: null,
    requestedBy: TEST_USER_ID_1,
    scheduledFor: null,
    startedAt: new Date("2026-03-19T10:00:00Z"),
    completedAt: new Date("2026-03-19T10:00:05Z"),
    status: "success",
    attemptCount: 0,
    langfuseTraceId: null,
    errorCode: null,
    errorMessage: null,
    stateKey: "sk-abc",
    ...overrides,
  };
}

// Mint a real HMAC-signed token using the same secret the mocked env returns.
// If the resolver chain is broken (recursion, wrong import), this token still
// parses correctly but no session user ever comes back — so the 200 assertion
// below fails deterministically.
const VALID_AGENT_TOKEN = issueAgentApiKey({
  userId: TEST_USER_ID_1,
  displayName: "Test Validator",
});

describe("GET /api/v1/agent/runs — real resolver chain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with runs when a real HMAC-signed bearer token is presented", async () => {
    mockHeaders.mockResolvedValue(
      headersFromRecord({ authorization: `Bearer ${VALID_AGENT_TOKEN}` })
    );
    mockListRunsByUser.mockResolvedValue([makeRun()]);

    await testApiHandler({
      appHandler,
      url: "/api/v1/agent/runs",
      async test({ fetch }) {
        const res = await fetch({ method: "GET" });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.runs).toHaveLength(1);
        // Session getter MUST NOT be called when a valid bearer is present.
        expect(mockGetServerSessionUser).not.toHaveBeenCalled();
      },
    });
  });

  it("returns 401 when no credentials are presented (real session fallback path)", async () => {
    mockHeaders.mockResolvedValue(headersFromRecord({}));
    mockGetServerSessionUser.mockResolvedValue(null);

    await testApiHandler({
      appHandler,
      url: "/api/v1/agent/runs",
      async test({ fetch }) {
        const res = await fetch({ method: "GET" });
        expect(res.status).toBe(401);
        // Real resolver must have delegated to the leaf session getter.
        expect(mockGetServerSessionUser).toHaveBeenCalledTimes(1);
      },
    });
  });

  it("returns 401 on a forged/invalid bearer token", async () => {
    mockHeaders.mockResolvedValue(
      headersFromRecord({
        authorization: "Bearer cogni_ag_sk_v1_not-a-real-token",
      })
    );

    await testApiHandler({
      appHandler,
      url: "/api/v1/agent/runs",
      async test({ fetch }) {
        const res = await fetch({ method: "GET" });
        expect(res.status).toBe(401);
        // Bearer claim is exclusive — must NOT fall back to session.
        expect(mockGetServerSessionUser).not.toHaveBeenCalled();
      },
    });
  });

  // Retain legacy symbol import for typing compatibility with _fakes/ids.
  void TEST_SESSION_USER_1;
});
