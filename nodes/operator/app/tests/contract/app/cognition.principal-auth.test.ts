// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Fresh durable-agent proof for the session cognition bootstrap seam. */
import { testApiHandler } from "next-test-api-route-handler";
import { describe, expect, it, vi } from "vitest";

const resolveRequestPrincipal = vi.hoisted(() => vi.fn());
const logRequestEnd = vi.hoisted(() => vi.fn());
const logRequestStart = vi.hoisted(() => vi.fn());
const mockLog = vi.hoisted(() => ({
  child: vi.fn().mockReturnThis(),
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/app/_lib/auth/request-identity", () => ({
  RequestIdentityUnavailableError: class RequestIdentityUnavailableError extends Error {},
  resolveRequestPrincipal,
}));

vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    log: mockLog,
    clock: { now: () => new Date("2026-10-15T00:00:00Z") },
    config: { unhandledErrorPolicy: "rethrow" },
    nodeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    knowledgeStorePort: null,
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

vi.mock("@/shared/config", () => ({
  getNodeMission: () => "Coordinate code and validation.",
  getNodeName: () => "operator",
}));

vi.mock("@/shared/env", () => ({
  serverEnv: () => ({ APP_BUILD_SHA: "candidate-sha" }),
}));

vi.mock("@/shared/observability", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/shared/observability")>();
  return {
    ...actual,
    createRequestContext: () => ({
      log: mockLog,
      reqId: "req-1",
      routeId: "cognition.bundle",
    }),
    logRequestEnd,
    logRequestStart,
  };
});

import * as appHandler from "@/app/api/v1/cognition/route";

describe("GET /api/v1/cognition principal authentication", () => {
  it("accepts a freshly spawned durable actor with no legacy user link", async () => {
    resolveRequestPrincipal.mockResolvedValue({
      kind: "agent",
      principalId:
        "agent:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      actorId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      credentialId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      billingAccountId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      displayName: "fresh-agent",
      legacyUserId: null,
    });

    await testApiHandler({
      appHandler,
      url: "/api/v1/cognition",
      async test({ fetch }) {
        const response = await fetch({
          headers: {
            authorization:
              "Bearer cogni_ag_sk_v2_cccccccc-cccc-4ccc-8ccc-cccccccccccc.secret",
          },
        });
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
          node: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          name: "operator",
          buildSha: "candidate-sha",
        });
        expect(resolveRequestPrincipal).toHaveBeenCalledTimes(1);
        expect(logRequestStart).toHaveBeenCalledTimes(1);
        expect(logRequestEnd).toHaveBeenCalledTimes(1);
        expect(logRequestEnd).toHaveBeenCalledWith(
          mockLog,
          expect.objectContaining({ status: 200 })
        );
      },
    });
  });
});
