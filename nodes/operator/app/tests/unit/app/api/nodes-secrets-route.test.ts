// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/nodes-secrets-route`
 * Purpose: Unit coverage for POST /api/v1/nodes/[id]/secrets, focused on the optional
 *   platform-service target: the no-`service` path must stay identical to before, and a
 *   platform-service write must require BOTH the allowlist and the owner node.
 * Scope: Mocks the logging wrapper, auth, node-rbac, env, and the secrets plane; no OpenBao,
 *   no OpenFGA, no Postgres.
 * Side-effects: none
 * Links: src/app/api/v1/nodes/[id]/secrets/route.ts, src/shared/secrets/platform-services.data.ts
 * @internal
 */

import type { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const gateState = vi.hoisted(() => ({
  result: {
    ok: true,
    node: { nodeId: "node-uuid", slug: "operator" },
  } as unknown,
}));

const planeState = vi.hoisted(() => ({
  writeSecret: vi.fn(),
  createThrows: false,
}));

const logLines = vi.hoisted(() => [] as unknown[]);

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_options: unknown, handler: (...args: unknown[]) => unknown) =>
    (request: unknown, routeCtx: unknown) => {
      const log = (fields: unknown): void => {
        logLines.push(fields);
      };
      const ctx = {
        reqId: "req-1",
        routeId: "nodes.secrets",
        log: { info: log, warn: log, error: log },
      };
      return handler(ctx, request, { id: "user-1" }, routeCtx);
    },
}));

vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));

vi.mock("@/app/_lib/node-rbac", () => ({
  resolveNodeAndAuthorize: async () => gateState.result,
}));

vi.mock("@/shared/env", () => ({
  serverEnv: () => ({ DEPLOY_ENVIRONMENT: "candidate-a" }),
}));

vi.mock("@/bootstrap/capabilities/operator-secrets-plane", () => ({
  createOperatorSecretsPlane: () => {
    if (planeState.createThrows) throw new Error("not configured");
    return { writeSecret: planeState.writeSecret };
  },
}));

import { POST } from "@/app/api/v1/nodes/[id]/secrets/route";

const VALUE = "sk-vendor-minted-do-not-log";

function post(body: unknown, id = "operator"): Promise<NextResponse> {
  const request = {
    json: async () => body,
  } as unknown as Parameters<typeof POST>[0];
  return POST(request, { params: Promise.resolve({ id }) }) as Promise<
    ReturnType<typeof NextResponse.json>
  >;
}

describe("POST /api/v1/nodes/[id]/secrets — platform-service target", () => {
  beforeEach(() => {
    logLines.length = 0;
    planeState.createThrows = false;
    planeState.writeSecret.mockReset();
    planeState.writeSecret.mockResolvedValue({
      written: true,
      version: 3,
      path: "cogni/candidate-a/akash-tx-actuator/AKASH_ACTUATOR_CONSOLE_API_KEY",
    });
    gateState.result = {
      ok: true,
      node: { nodeId: "node-uuid", slug: "operator" },
    };
  });

  it("omits `service` from the plane input when the caller omits it (no-op for node writes)", async () => {
    gateState.result = {
      ok: true,
      node: { nodeId: "poly-uuid", slug: "poly" },
    };
    planeState.writeSecret.mockResolvedValue({
      written: true,
      version: 1,
      path: "cogni/candidate-a/poly/POLYGON_RPC_URL",
    });

    const res = await post({
      env: "candidate-a",
      key: "POLYGON_RPC_URL",
      value: VALUE,
    });

    expect(res.status).toBe(200);
    expect(planeState.writeSecret).toHaveBeenCalledWith({
      nodeSlug: "poly",
      service: undefined,
      env: "candidate-a",
      key: "POLYGON_RPC_URL",
      value: VALUE,
      op: "set",
    });
    await expect(res.json()).resolves.toEqual({
      written: true,
      version: 1,
      path: "cogni/candidate-a/poly/POLYGON_RPC_URL",
    });
  });

  it("routes an allowlisted platform service written by the owner node", async () => {
    const res = await post({
      env: "candidate-a",
      key: "AKASH_ACTUATOR_CONSOLE_API_KEY",
      value: VALUE,
      service: "akash-tx-actuator",
    });

    expect(res.status).toBe(200);
    expect(planeState.writeSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeSlug: "operator",
        service: "akash-tx-actuator",
        env: "candidate-a",
        key: "AKASH_ACTUATOR_CONSOLE_API_KEY",
      })
    );
    await expect(res.json()).resolves.toEqual({
      written: true,
      version: 3,
      path: "cogni/candidate-a/akash-tx-actuator/AKASH_ACTUATOR_CONSOLE_API_KEY",
    });
  });

  it("403s a platform-service write from a node that does not administer them", async () => {
    gateState.result = {
      ok: true,
      node: { nodeId: "poly-uuid", slug: "poly" },
    };

    const res = await post(
      {
        env: "candidate-a",
        key: "AKASH_ACTUATOR_CONSOLE_API_KEY",
        value: VALUE,
        service: "akash-tx-actuator",
      },
      "poly"
    );

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      errorCode: "platform_service_not_owned",
    });
    expect(planeState.writeSecret).not.toHaveBeenCalled();
  });

  it("403s an un-allowlisted service even for the owner node", async () => {
    const res = await post({
      env: "candidate-a",
      key: "SOME_KEY",
      value: VALUE,
      service: "_shared",
    });

    // `_shared` never reaches the allowlist branch: the Zod charset rejects a
    // leading underscore first, so OpenBao's policy deny is never even relied on.
    expect(res.status).toBe(400);
    expect(planeState.writeSecret).not.toHaveBeenCalled();

    const unknown = await post({
      env: "candidate-a",
      key: "SOME_KEY",
      value: VALUE,
      service: "operator",
    });
    expect(unknown.status).toBe(403);
    await expect(unknown.json()).resolves.toMatchObject({
      errorCode: "unknown_platform_service",
    });
    expect(planeState.writeSecret).not.toHaveBeenCalled();
  });

  it("400s an unrecognized field instead of silently dropping it", async () => {
    // The incident, generalized: a caller sent `service` to an operator build that did
    // not yet have the parameter. A permissive schema dropped it and wrote the node path
    // anyway, returning 200. Strictness turns operator/caller version skew into a loud
    // failure — the caller cannot otherwise tell a honoured field from a discarded one.
    const res = await post({
      env: "candidate-a",
      key: "SOME_KEY",
      value: VALUE,
      serviceTypo: "akash-tx-actuator",
    });

    expect(res.status).toBe(400);
    expect(planeState.writeSecret).not.toHaveBeenCalled();
  });

  it("403s a platform-service key written WITHOUT `service` (the misfiling shape)", async () => {
    // This is the exact write that put an Akash wallet credential into
    // cogni/<env>/operator — the bucket the internet-facing app reads wholesale.
    // It must never reach the plane, even though `operator` is a legitimate node and
    // the caller legitimately administers platform services.
    const res = await post({
      env: "candidate-a",
      key: "AKASH_ACTUATOR_CONSOLE_API_KEY",
      value: VALUE,
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      errorCode: "key_belongs_to_platform_service",
    });
    expect(planeState.writeSecret).not.toHaveBeenCalled();
  });

  it("still writes a platform-service key to its OWN service", async () => {
    // The binding must not break the one write that has to work: the vendor-minted
    // Console key is `source: human`, so this route is its only sanctioned arrival path.
    const res = await post({
      env: "candidate-a",
      key: "AKASH_ACTUATOR_CONSOLE_API_KEY",
      value: VALUE,
      service: "akash-tx-actuator",
    });

    expect(res.status).toBe(200);
    expect(planeState.writeSecret).toHaveBeenCalledWith(
      expect.objectContaining({ service: "akash-tx-actuator" })
    );
  });

  it("403s an inheritFrom key written by a NON-owner node (bug.5016)", async () => {
    // poly writes OPENROUTER_API_KEY into its own bank: 200 today, then the next flight
    // restores operator's value because the key is overwrite-on-drift. Refuse, and name
    // the owner so the caller is redirected to the write that actually persists.
    gateState.result = {
      ok: true,
      node: { nodeId: "poly-uuid", slug: "poly" },
    };

    const res = await post(
      { env: "candidate-a", key: "OPENROUTER_API_KEY", value: VALUE },
      "poly"
    );

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      errorCode: "key_inherited_from_owner",
    });
    expect(planeState.writeSecret).not.toHaveBeenCalled();
  });

  it("still lets the OWNER node rotate an inheritFrom key", async () => {
    // The regression guard. `operator` holds the canonical value, so this write IS the
    // rotation and is the documented clean path (openrouter-api-key-expert). A blanket
    // denylist would have broken it while claiming to fix bug.5016.
    const res = await post({
      env: "candidate-a",
      key: "OPENROUTER_API_KEY",
      value: VALUE,
      op: "rotate",
    });

    expect(res.status).toBe(200);
    expect(planeState.writeSecret).toHaveBeenCalledWith(
      expect.objectContaining({ nodeSlug: "operator", op: "rotate" })
    );
  });

  it("still refuses a substrate-reserved key on a platform-service path", async () => {
    const res = await post({
      env: "candidate-a",
      key: "AKASH_TX_ACTUATOR_TOKEN",
      value: VALUE,
      service: "akash-tx-actuator",
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      errorCode: "key_reserved",
    });
    expect(planeState.writeSecret).not.toHaveBeenCalled();
  });

  it("still 409s a cross-env platform-service write before any authz or write", async () => {
    const res = await post({
      env: "production",
      key: "AKASH_ACTUATOR_CONSOLE_API_KEY",
      value: VALUE,
      service: "akash-tx-actuator",
    });

    expect(res.status).toBe(409);
    expect(planeState.writeSecret).not.toHaveBeenCalled();
  });

  it("never puts the value in a log line or a response body", async () => {
    const res = await post({
      env: "candidate-a",
      key: "AKASH_ACTUATOR_CONSOLE_API_KEY",
      value: VALUE,
      service: "akash-tx-actuator",
    });

    expect(JSON.stringify(await res.json())).not.toContain(VALUE);
    expect(logLines.length).toBeGreaterThan(0);
    expect(JSON.stringify(logLines)).not.toContain(VALUE);
    expect(JSON.stringify(logLines)).toContain("akash-tx-actuator");
  });
});
