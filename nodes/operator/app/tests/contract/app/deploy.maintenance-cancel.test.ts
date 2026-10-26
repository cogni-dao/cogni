// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * Module: `@tests/contract/app/deploy.maintenance-cancel`
 * Purpose: Verify the public cancellation boundary and operator-owned authorization.
 * Scope: Real HTTP handler with recording auth and deploy ports; no database mocks or Git IO.
 * Invariants: every denial makes zero deploy calls; caller cannot choose custody or other lanes.
 * Side-effects: none
 * Links: task.5345
 * @internal
 */
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  cancel: vi.fn(),
  resolve: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn() },
  session: { id: "actor" } as { id: string } | null,
}));
vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: async () => mocks.session,
}));
vi.mock("@/app/_lib/node-rbac", () => ({
  resolveNodeAndAuthorize: mocks.auth,
}));
vi.mock("@/features/nodes/node-lookup", () => ({
  resolveNodeRef: mocks.resolve,
}));
vi.mock("@/bootstrap/container", () => ({ resolveServiceDb: () => ({}) }));
vi.mock("@/shared/env", () => ({ serverEnv: () => ({}) }));
vi.mock("@/bootstrap/capabilities/operator-deploy-plane", () => ({
  createOperatorDeployPlane: () => ({
    cancelCandidateMaintenance: mocks.cancel,
  }),
}));
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (
      _options: unknown,
      handler: (ctx: unknown, req: Request, user: unknown) => Promise<Response>
    ) =>
    (req: Request) =>
      handler({ log: mocks.log }, req, mocks.session),
}));

import * as route from "@/app/api/v1/deploy/maintenance-cancel/route";

const nodeId = "b927a9dd-6132-4fc9-a51e-e3cee2568e3c";
const input = {
  nodeId,
  env: "candidate-a",
  operationId: "1".repeat(64),
  expectedDeployHead: "a".repeat(40),
  expectedMarkerSha256: "2".repeat(64),
  reason: "Abandoned legacy intent",
};
async function post(body: unknown) {
  let result: { status: number; body: unknown } | undefined;
  await testApiHandler({
    appHandler: route,
    test: async ({ fetch }) => {
      const r = await fetch({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      result = { status: r.status, body: await r.json() };
    },
  });
  return result;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.session = { id: "actor" };
  mocks.auth.mockResolvedValue({
    ok: true,
    node: { nodeId: "operator-id", slug: "operator" },
  });
  mocks.resolve.mockResolvedValue({ nodeId, slug: "node-template" });
  mocks.cancel.mockResolvedValue({
    commitSha: "c".repeat(40),
    previousHead: input.expectedDeployHead,
    treeSha: "d".repeat(40),
    branch: "deploy/candidate-a-node-template",
    operationId: input.operationId,
  });
});
describe("POST maintenance-cancel", () => {
  it("authorizes operator env_manager and binds resolved target", async () => {
    expect((await post(input))?.status).toBe(200);
    expect(mocks.auth).toHaveBeenCalledWith({
      id: "operator",
      userId: "actor",
      action: "node.manage_envs",
    });
    expect(mocks.cancel).toHaveBeenCalledWith({
      ...input,
      slug: "node-template",
      actorId: "user:actor",
    });
  });
  it.each([
    403, 503,
  ])("preserves auth failure %s before Git IO", async (status) => {
    mocks.auth.mockResolvedValue({
      ok: false,
      status,
      errorCode: status === 403 ? "authz_denied" : "authz_unavailable",
    });
    expect((await post(input))?.status).toBe(status);
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it("refuses missing authentication", async () => {
    mocks.session = null;
    expect((await post(input))?.status).toBe(401);
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it.each([
    { env: "production" },
    { branch: "main" },
    { repository: "cogni-dao/cogni" },
    { reason: "line\nbreak" },
  ])("refuses unsupported caller authority %j", async (extra) => {
    expect((await post({ ...input, ...extra }))?.status).toBe(400);
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it("preserves CAS conflict", async () => {
    mocks.cancel.mockRejectedValue(
      Object.assign(new Error("changed"), {
        code: "maintenance_head_conflict",
        status: 409,
      })
    );
    expect(await post(input)).toEqual({
      status: 409,
      body: { error: "maintenance_head_conflict" },
    });
  });
  it("does not expose unexpected SDK error contents", async () => {
    mocks.cancel.mockRejectedValue(new Error("private provider details"));
    expect(await post(input)).toEqual({
      status: 502,
      body: { error: "maintenance_unavailable" },
    });
  });
});
