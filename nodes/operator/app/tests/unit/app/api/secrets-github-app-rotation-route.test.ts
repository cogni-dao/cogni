// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/secrets-github-app-rotation-route`
 * Purpose: Unit coverage for POST /api/v1/secrets/github-app/rotation — the gate
 *   order (strict schema → server-pinned operator RBAC → plane wiring), the typed
 *   conclusion → HTTP status map (invalid/misbound never 2xx), and the
 *   no-secret-in-logs invariant.
 * Scope: Mocks the logging wrapper, auth, node-rbac, env, the plane factory, and
 *   the facade; no OpenBao, no GitHub, no OpenFGA.
 * Side-effects: none
 * Links: src/app/api/v1/secrets/github-app/rotation/route.ts, subtask.5016
 * @internal
 */

import type { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const gateState = vi.hoisted(() => ({
  result: {
    ok: true,
    node: { nodeId: "node-uuid", slug: "operator" },
  } as unknown,
  calls: [] as unknown[],
}));

const facadeState = vi.hoisted(() => ({
  report: {} as Record<string, unknown>,
  throws: null as Error | null,
  calls: [] as unknown[],
}));

const planeState = vi.hoisted(() => ({ createThrows: false }));

const logLines = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_options: unknown, handler: (...args: unknown[]) => unknown) =>
    (request: unknown, routeCtx: unknown) => {
      const log = (fields: Record<string, unknown>): void => {
        logLines.push(fields);
      };
      const ctx = {
        reqId: "req-1",
        routeId: "secrets.github-app.rotation",
        log: { info: log, warn: log, error: log },
      };
      return handler(ctx, request, { id: "user-1" }, routeCtx);
    },
}));

vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));

vi.mock("@/app/_lib/node-rbac", () => ({
  resolveNodeAndAuthorize: async (input: unknown) => {
    gateState.calls.push(input);
    return gateState.result;
  },
}));

vi.mock("@/shared/env", () => ({
  serverEnv: () => ({ DEPLOY_ENVIRONMENT: "candidate-a" }),
}));

vi.mock("@/bootstrap/capabilities/operator-app-credentials", () => ({
  createOperatorAppCredentialsPlane: () => {
    if (planeState.createThrows) throw new Error("not configured");
    return { store: {}, github: {} };
  },
}));

vi.mock("@/features/secrets/app-credential-rotation.service", async () => {
  const actual = await vi.importActual<
    typeof import("@/features/secrets/app-credential-rotation.service")
  >("@/features/secrets/app-credential-rotation.service");
  return {
    DeployEnvUnsetError: actual.DeployEnvUnsetError,
    rotateOperatorAppCredential: async (_deps: unknown, staged: unknown) => {
      facadeState.calls.push(staged);
      if (facadeState.throws) throw facadeState.throws;
      return facadeState.report;
    },
    evaluateOperatorAppCredentialHealth: async () => facadeState.report,
  };
});

import { POST } from "@/app/api/v1/secrets/github-app/rotation/route";

const STAGED_KEY_B64 = Buffer.from(
  "-----BEGIN PRIVATE KEY-----\nfake-not-logged\n-----END PRIVATE KEY-----"
).toString("base64");

function post(body: unknown): Promise<NextResponse> {
  const request = new Request(
    "http://localhost/api/v1/secrets/github-app/rotation",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  return POST(request as never, undefined as never) as Promise<NextResponse>;
}

function baseReport(conclusion: string): Record<string, unknown> {
  return {
    conclusion,
    env: "candidate-a",
    reasons: [],
    staged: { appId: "3956976", keyFingerprint: "f".repeat(64) },
    bankCustody: "unobservable",
  };
}

beforeEach(() => {
  gateState.result = {
    ok: true,
    node: { nodeId: "node-uuid", slug: "operator" },
  };
  gateState.calls = [];
  facadeState.report = baseReport("written_not_propagated");
  facadeState.throws = null;
  facadeState.calls = [];
  planeState.createThrows = false;
  logLines.length = 0;
});

describe("POST /api/v1/secrets/github-app/rotation", () => {
  it("pins RBAC to the operator node — the caller cannot retarget the gate", async () => {
    const res = await post({
      appId: "3956976",
      privateKeyBase64: STAGED_KEY_B64,
    });
    expect(res.status).toBe(200);
    expect(gateState.calls).toEqual([
      { id: "operator", userId: "user-1", action: "node.manage_secrets" },
    ]);
    expect(facadeState.calls).toEqual([
      { appId: "3956976", privateKeyBase64: STAGED_KEY_B64 },
    ]);
  });

  it("rejects unknown fields loudly (strict schema) — no silent env/path/service choice", async () => {
    const res = await post({
      appId: "3956976",
      privateKeyBase64: STAGED_KEY_B64,
      env: "production",
    });
    expect(res.status).toBe(400);
    expect(facadeState.calls).toEqual([]);
  });

  it("rejects a non-numeric appId", async () => {
    const res = await post({
      appId: "cogni-operator-test",
      privateKeyBase64: STAGED_KEY_B64,
    });
    expect(res.status).toBe(400);
  });

  it("maps RBAC refusals before any plane work: 403 authz_denied / 503 authz_unavailable", async () => {
    gateState.result = {
      ok: false,
      status: 403,
      errorCode: "authz_denied",
      slug: "operator",
    };
    const denied = await post({
      appId: "3956976",
      privateKeyBase64: STAGED_KEY_B64,
    });
    expect(denied.status).toBe(403);
    expect(facadeState.calls).toEqual([]);

    gateState.result = {
      ok: false,
      status: 503,
      errorCode: "authz_unavailable",
      slug: "operator",
    };
    const unavailable = await post({
      appId: "3956976",
      privateKeyBase64: STAGED_KEY_B64,
    });
    expect(unavailable.status).toBe(503);
  });

  it("returns 503 secrets_plane_config_missing when the plane cannot be wired", async () => {
    planeState.createThrows = true;
    const res = await post({
      appId: "3956976",
      privateKeyBase64: STAGED_KEY_B64,
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { errorCode: string }).errorCode).toBe(
      "secrets_plane_config_missing"
    );
  });

  it.each([
    ["current", 200],
    ["rotated", 200],
    ["written_not_propagated", 200],
    ["unconfigured", 503],
    ["invalid", 422],
    ["misbound", 422],
    ["failed", 502],
  ] as const)("maps conclusion %s to HTTP %i — invalid/misbound never render success", async (conclusion, status) => {
    facadeState.report = baseReport(conclusion);
    const res = await post({
      appId: "3956976",
      privateKeyBase64: STAGED_KEY_B64,
    });
    expect(res.status).toBe(status);
    expect(((await res.json()) as { conclusion: string }).conclusion).toBe(
      conclusion
    );
  });

  it("maps DeployEnvUnsetError to 503 deploy_env_unset", async () => {
    const { DeployEnvUnsetError } = await import(
      "@/features/secrets/app-credential-rotation.service"
    );
    facadeState.throws = new DeployEnvUnsetError();
    const res = await post({
      appId: "3956976",
      privateKeyBase64: STAGED_KEY_B64,
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { errorCode: string }).errorCode).toBe(
      "deploy_env_unset"
    );
  });

  it("never puts the staged key in a log line, and logs the typed conclusion", async () => {
    await post({ appId: "3956976", privateKeyBase64: STAGED_KEY_B64 });
    const serialized = JSON.stringify(logLines);
    expect(serialized).not.toContain(STAGED_KEY_B64.slice(0, 24));
    expect(serialized).toContain("written_not_propagated");
    expect(serialized).toContain(
      "feature.operator_app_credential_rotation.complete"
    );
  });
});
