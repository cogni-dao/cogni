// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authorize = vi.fn();
const writeSecret = vi.fn();
const info = vi.fn();

const NODE_ID = "11111111-1111-4111-8111-111111111111";

vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(async () => ({ id: "user-1" })),
}));
vi.mock("@/app/_lib/node-rbac", () => ({
  resolveNodeAndAuthorize: authorize,
}));
vi.mock("@/bootstrap/capabilities/operator-secrets-plane", () => ({
  createOperatorSecretsPlane: () => ({ writeSecret }),
}));
vi.mock("@/shared/env", () => ({
  serverEnv: () => ({
    DEPLOY_ENVIRONMENT: "production",
    FLEET_CONTROL_ENV: "production",
  }),
}));
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_config: unknown, handler: (...args: unknown[]) => Promise<Response>) =>
    (request: Request, context: unknown) =>
      handler(
        {
          reqId: "req-rotate",
          log: { warn: vi.fn(), info, error: vi.fn() },
        },
        request,
        { id: "user-1" },
        context
      ),
}));

async function post(env = "production"): Promise<Response> {
  const { POST } = await import("./route");
  return POST(
    new Request(
      `https://operator.example/api/v1/nodes/${NODE_ID}/authorization-credential/rotate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ env }),
      }
    ) as NextRequest,
    { params: Promise.resolve({ id: NODE_ID }) }
  );
}

describe("POST /api/v1/nodes/[id]/authorization-credential/rotate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authorize.mockResolvedValue({
      ok: true,
      node: {
        nodeId: NODE_ID,
        slug: "poly",
        deployEnvs: ["production"],
        activityEnv: "production",
      },
    });
    writeSecret.mockResolvedValue({
      written: true,
      version: 8,
      path: "cogni/production/poly/AUTHORIZATION_FACADE_TOKEN",
    });
  });

  it("reports prepared until redeploy and active/retired verification", async () => {
    const response = await post();
    expect(response.status).toBe(202);
    expect(authorize).toHaveBeenCalledWith({
      id: NODE_ID,
      userId: "user-1",
      action: "node.manage_secrets",
    });
    expect(writeSecret).toHaveBeenCalledWith({
      nodeSlug: "poly",
      env: "production",
      key: "AUTHORIZATION_FACADE_TOKEN",
      value: expect.stringMatching(
        new RegExp(`^cogni_naz_sk_v1_${NODE_ID}_[0-9a-f]{64}$`)
      ),
      op: "rotate",
    });
    const body = await response.json();
    expect(body).toEqual({
      state: "prepared",
      version: 8,
      path: "cogni/production/poly/AUTHORIZATION_FACADE_TOKEN",
      overlapWindowSeconds: 600,
      requiredNext: "redeploy_and_verify",
    });
    expect(body).not.toHaveProperty("rotated");
    expect(JSON.stringify(body)).not.toContain("cogni_naz_sk_v1_");
    expect(JSON.stringify(info.mock.calls)).not.toContain("cogni_naz_sk_v1_");
  });

  it("fails before generation/write when human node authority is denied", async () => {
    authorize.mockResolvedValue({
      ok: false,
      status: 403,
      errorCode: "authz_denied",
    });
    const response = await post();
    expect(response.status).toBe(403);
    expect(writeSecret).not.toHaveBeenCalled();
  });

  it("writes an explicit down-trust lane without inferring it from the server", async () => {
    authorize.mockResolvedValue({
      ok: true,
      node: {
        nodeId: NODE_ID,
        slug: "poly",
        deployEnvs: ["preview"],
        activityEnv: "production",
      },
    });
    const response = await post("preview");
    expect(response.status).toBe(202);
    expect(writeSecret).toHaveBeenCalledWith(
      expect.objectContaining({ env: "preview" })
    );
  });

  it("refuses a node absent from the served environment", async () => {
    authorize.mockResolvedValue({
      ok: true,
      node: {
        nodeId: NODE_ID,
        slug: "poly",
        deployEnvs: ["candidate-a"],
        activityEnv: "candidate-a",
      },
    });
    const response = await post();
    expect(response.status).toBe(409);
    expect(writeSecret).not.toHaveBeenCalled();
  });
});
