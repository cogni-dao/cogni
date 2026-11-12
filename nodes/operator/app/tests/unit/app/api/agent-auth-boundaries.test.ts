// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/agent-auth-boundaries`
 * Purpose: Real resolver failures retain package HTTP status and direct-route terminal evidence.
 * Scope: Three direct route boundaries with unit store/leaf adapters; no external services.
 * Invariants: Superseded401, limited429, unavailable503; one existing terminal event; unknown failures propagate.
 * Side-effects: none (unit adapters).
 * Links: story.5156, app/_lib/auth/route-identity.ts
 */
import {
  type CredentialState,
  type CredentialStore,
  formatRevocableKey,
  verifyBearer,
} from "@cogni-dao/agent-grants/credentials";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryCredentialStore } from "../../../_fakes/agent-credentials-memory-store";

const fake = vi.hoisted(() => ({
  kind: "superseded",
  token: "",
  store: undefined as unknown as CredentialStore,
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  },
}));
vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (name: string) =>
      name === "authorization" ? `Bearer ${fake.token}` : null,
  }),
}));
vi.mock("@/lib/auth/server", () => ({
  getServerSessionUser: async () => null,
}));
vi.mock("@/shared/env/server", () => ({
  serverEnv: () => ({
    AUTH_SECRET: "unit-secret-for-boundary-regression-only",
  }),
}));
vi.mock("@/bootstrap/agent-credentials", () => ({
  getAgentCredentialStore: () => ({
    ...fake.store,
    everConfirmed: async () => fake.kind === "superseded",
  }),
  verifyAgentCredential: (
    store: CredentialStore,
    token: string,
    allow: readonly CredentialState[]
  ) =>
    verifyBearer(store, token, allow, { admit: () => fake.kind !== "limited" }),
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({ authorization: undefined }),
  resolveServiceDb: vi.fn(() => {
    throw new Error("auth must terminate before database access");
  }),
}));
vi.mock("@/app/_lib/node-rbac", () => ({ resolveNodeAndAuthorize: vi.fn() }));
vi.mock("@/bootstrap/node-flight.factory", () => ({
  createNodeProber: vi.fn(),
}));
vi.mock("@/bootstrap/observability.factory", () => ({
  createLokiReader: vi.fn(),
}));
vi.mock("@/shared/observability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/observability")>()),
  makeLogger: () => fake.log,
}));

import { issueAgentApiKey } from "@/app/_lib/auth/request-identity";
import { resolveRouteIdentity } from "@/app/_lib/auth/route-identity";
import { resolveNodeAndAuthorize } from "@/app/_lib/node-rbac";
import { GET as flight } from "@/app/api/v1/nodes/[id]/flight-status/route";
import { GET as schema } from "@/app/api/v1/nodes/[id]/observability/db/schema/route";
import { GET as logs } from "@/app/api/v1/nodes/[id]/observability/logs/route";
import { EVENT_NAMES } from "@/shared/observability";

beforeEach(() => {
  vi.clearAllMocks();
  fake.log.child.mockReturnValue(fake.log);
});
describe("direct route auth boundaries use the real resolver", () => {
  for (const [name, route, event] of [
    ["flight-status", flight, null],
    ["logs", logs, EVENT_NAMES.NODE_OBSERVABILITY_LOGS_COMPLETE],
    [
      "database-schema",
      schema,
      EVENT_NAMES.NODE_OBSERVABILITY_DB_SCHEMA_COMPLETE,
    ],
  ] as const) {
    it.each([
      "superseded",
      "limited",
      "outage",
    ])(`${name} preserves %s classification before route work`, async (kind) => {
      fake.kind = kind;
      const memory = memoryCredentialStore({
        users: {},
        failing: kind === "outage",
      });
      fake.store = memory.store;
      fake.token =
        kind === "superseded"
          ? issueAgentApiKey({ userId: "fixture", displayName: "Fixture" })
          : formatRevocableKey("a".repeat(43));
      const response = await route(
        new NextRequest("http://localhost/api/v1/nodes/fixture/x", {
          headers: { authorization: `Bearer ${fake.token}` },
        }),
        { params: Promise.resolve({ id: "fixture" }) }
      );
      const status =
        kind === "superseded" ? 401 : kind === "limited" ? 429 : 503;
      const error =
        kind === "superseded"
          ? "v1_superseded"
          : kind === "limited"
            ? "rate_limited"
            : "authz_unavailable";
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(resolveNodeAndAuthorize).not.toHaveBeenCalled();
      if (event) {
        const terminal = [
          ...fake.log.warn.mock.calls,
          ...fake.log.error.mock.calls,
        ].filter(([fields]) => fields?.event === event);
        expect(terminal).toHaveLength(1);
        expect(terminal[0]?.[0]).toMatchObject({
          status,
          errorCode: error,
          outcome: "error",
        });
      }
    });
  }
  it("does not relabel an unrelated resolver defect as an auth refusal", async () => {
    const error = new Error("unit resolver defect");
    await expect(
      resolveRouteIdentity(async () => {
        throw error;
      })
    ).rejects.toBe(error);
  });
});
