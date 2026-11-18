// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/deploy/instances` (test)
 * Purpose: Pin the instance directory route (story.5159 step 1): the shared deploy gate runs BEFORE any
 *   row is read, a refused lane reads nothing, a missing zone is a 503 (never an unguarded host list), a bad
 *   query is a 400, and a served read returns the instances the feature derived for this node and env.
 * Scope: Mocked IO collaborators (gate, lane refusals, store, session); the contract and the real feature
 *   function run unchanged.
 * Side-effects: none
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DeployInstancesReadSchema } from "@/contracts/deploy.instances.v1.contract";

const NODE_ID = "f66b260b-4633-41e2-8711-b7c1b8449cc1";
const SHA = "3".repeat(40);
const REL = "00000000-0000-4000-8000-000000000001";

const zone = vi.hoisted(() => ({
  value: "cognidao.org" as string | undefined,
}));
const gate = vi.fn();
const envNotServed = vi.fn();
const listDesired = vi.fn();
const attemptsFor = vi.fn();
const getRelease = vi.fn();

vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(async () => ({ id: "user-1" })),
}));
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_config: unknown, handler: (...args: unknown[]) => Promise<Response>) =>
    (request: Request) =>
      handler(
        {
          reqId: "req-1",
          routeId: "deploy.instances.list",
          log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
        },
        request,
        { id: "user-1" }
      ),
}));
vi.mock("../workloads/_lib/gate", () => ({
  gate: (...args: unknown[]) => gate(...args),
}));
vi.mock("../workloads/_lib/lane", () => ({
  envNotServed: (...args: unknown[]) => envNotServed(...args),
}));
vi.mock("@/shared/env", () => ({
  serverEnv: () => ({
    NODE_SUBMODULE_PARENT_OWNER: "cogni-dao",
    NODE_DEPLOY_WORKLOAD_ZONE: zone.value,
  }),
}));
vi.mock("@/bootstrap/capabilities/node-deploy-store", () => ({
  createNodeDeployStore: () => ({ listDesired, attemptsFor, getRelease }),
}));

const get = async (query: string): Promise<Response> => {
  const { GET } = await import("./route");
  return GET(
    new Request(
      `https://operator.example/api/v1/deploy/instances${query}`
    ) as NextRequest,
    {} as never
  );
};

const GOOD = `?nodeId=${NODE_ID}&env=candidate-a`;

beforeEach(() => {
  vi.clearAllMocks();
  zone.value = "cognidao.org";
  gate.mockResolvedValue({
    ok: true,
    node: { id: NODE_ID, slug: "toks5" },
    catalogRow: {},
  });
  envNotServed.mockReturnValue(undefined);
  listDesired.mockResolvedValue([
    {
      nodeId: NODE_ID,
      env: "candidate-a",
      workload: "canary",
      state: "running",
      releaseId: REL,
      updatedAt: new Date(0),
    },
  ]);
  attemptsFor.mockResolvedValue([{ releaseId: REL, phase: "active" }]);
  getRelease.mockResolvedValue({
    id: REL,
    sourceSha: SHA,
    spec: {
      name: "canary",
      kind: "app",
      expose: { http: { host: "toks5-canary-test.cognidao.org" } },
    },
  });
});

describe("GET /api/v1/deploy/instances", () => {
  it("returns the proven instances of the node and env", async () => {
    const res = await get(GOOD);
    expect(res.status).toBe(200);
    const body = DeployInstancesReadSchema.parse(await res.json());
    expect(body.nodeId).toBe(NODE_ID);
    expect(body.instances).toEqual([
      {
        instance: "canary",
        workload: "canary",
        host: "toks5-canary-test.cognidao.org",
        releaseId: REL,
        sourceSha: SHA,
      },
    ]);
    expect(gate).toHaveBeenCalledWith("user-1", NODE_ID, "candidate-a");
    expect(listDesired).toHaveBeenCalledWith("candidate-a");
  });

  it("refuses at the gate before any row is read", async () => {
    gate.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "authz_denied" }, { status: 403 }),
    });
    const res = await get(GOOD);
    expect(res.status).toBe(403);
    expect(listDesired).not.toHaveBeenCalled();
  });

  it("refuses an env this operator does not serve before any row is read", async () => {
    envNotServed.mockReturnValue(
      NextResponse.json({ error: "env_not_served" }, { status: 409 })
    );
    const res = await get(GOOD);
    expect(res.status).toBe(409);
    expect(listDesired).not.toHaveBeenCalled();
  });

  it("answers 503 when the workload zone is not configured, never an unguarded list", async () => {
    zone.value = undefined;
    const res = await get(GOOD);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "workload_zone_not_configured" });
    expect(listDesired).not.toHaveBeenCalled();
  });

  it.each([
    "",
    `?nodeId=${NODE_ID}`,
    `?nodeId=${NODE_ID}&env=mars`,
  ])("rejects the query %s with 400 before the gate", async (query) => {
    const res = await get(query);
    expect(res.status).toBe(400);
    expect(gate).not.toHaveBeenCalled();
  });
});
