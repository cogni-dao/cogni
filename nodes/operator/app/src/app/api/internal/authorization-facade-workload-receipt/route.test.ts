// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
// biome-ignore-all lint/style/noProcessEnv: tests must control the exact process values the receipt proves

import type { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_config: unknown, handler: (...args: unknown[]) => Promise<Response>) =>
    (request: Request) =>
      handler(
        {
          reqId: "req-workload-receipt",
          routeId: "authorization.facade.workload_receipt",
          log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
        },
        request,
        null
      ),
}));

const TOKEN =
  "cogni_naz_sk_v2_production_11111111-1111-4111-8111-111111111111_" +
  "a".repeat(64);
const CHALLENGE = "b".repeat(64);

describe("authorization facade workload receipt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AUTHORIZATION_FACADE_TOKEN;
    delete process.env.APP_BUILD_SHA;
    delete process.env.NEXTAUTH_URL;
    delete process.env.NODE_NAME;
  });

  it("rejects malformed input before semantic transport", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    process.env.AUTHORIZATION_FACADE_TOKEN = TOKEN;
    const { POST } = await import("./route");

    const response = await POST(
      new Request(
        "https://poly.cognidao.org/api/internal/authorization-facade-workload-receipt",
        {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}` },
        }
      ) as NextRequest
    );

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a credential not loaded by this workload", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    process.env.AUTHORIZATION_FACADE_TOKEN = TOKEN;
    const { POST } = await import("./route");

    const response = await POST(
      new Request(
        "https://poly.cognidao.org/api/internal/authorization-facade-workload-receipt",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${TOKEN.slice(0, -1)}c`,
            "x-cogni-rotation-challenge": CHALLENGE,
          },
        }
      ) as NextRequest
    );

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns only a new-process receipt after a semantic facade decision", async () => {
    process.env.AUTHORIZATION_FACADE_TOKEN = TOKEN;
    process.env.APP_BUILD_SHA = "c".repeat(40);
    process.env.NEXTAUTH_URL = "https://poly.cognidao.org";
    process.env.NODE_NAME = "poly";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { decision: "deny", code: "authz_denied", checks: [] },
          { status: 403 }
        )
      );
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("./route");

    const response = await POST(
      new Request(
        "https://poly.cognidao.org/api/internal/authorization-facade-workload-receipt",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "x-cogni-rotation-challenge": CHALLENGE,
          },
        }
      ) as NextRequest
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      challenge: CHALLENGE,
      bootId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      buildSha: "c".repeat(40),
      semanticCode: "authz_denied",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://cognidao.org/api/v1/authorization/check"),
      expect.objectContaining({ method: "POST", redirect: "error" })
    );
  });
});
