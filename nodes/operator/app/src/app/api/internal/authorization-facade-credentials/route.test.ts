// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it, vi } from "vitest";
import {
  type AuthorizationFacadeProjectionDeps,
  handleAuthorizationFacadeCredentialProjection,
} from "./route";

const NODE_ID = "b927a9dd-6132-4fc9-a51e-e3cee2568e3c";
const ACTIVE = `cogni_naz_sk_v2_candidate-a_${NODE_ID}_${"a".repeat(64)}`;

function request(
  body: unknown = { lane: "candidate-a", nodeId: NODE_ID },
  url = "https://cognidao.org/api/internal/authorization-facade-credentials"
) {
  const encoded = JSON.stringify(body);
  return new Request(url, {
    method: "POST",
    headers: {
      authorization: "Bearer github-oidc-jwt",
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(encoded)),
    },
    body: encoded,
  });
}

function deps(
  overrides: Partial<AuthorizationFacadeProjectionDeps> = {}
): AuthorizationFacadeProjectionDeps {
  return {
    isControl: () => true,
    isCatalogNode: (nodeId) => nodeId === NODE_ID,
    consumeRateLimit: () => true,
    readRing: vi.fn().mockResolvedValue({ active: ACTIVE, previous: null }),
    audit: vi.fn(),
    ...overrides,
  };
}

describe("authorization-facade credential projection route", () => {
  it("returns the strict bounded ring with no-store", async () => {
    const d = deps();
    const response = await handleAuthorizationFacadeCredentialProjection(
      request(),
      d
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      active: ACTIVE,
      previous: null,
    });
  });

  it.each([
    ["non-control", { isControl: () => false }],
    ["unknown node", { isCatalogNode: () => false }],
    ["OIDC denial", { readRing: vi.fn().mockRejectedValue(new Error()) }],
  ])("returns the same denial for %s", async (_case, override) => {
    const response = await handleAuthorizationFacadeCredentialProjection(
      request(),
      deps(override)
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("rejects plaintext before any secret read", async () => {
    const d = deps();
    const response = await handleAuthorizationFacadeCredentialProjection(
      request(
        undefined,
        "http://cognidao.org/api/internal/authorization-facade-credentials"
      ),
      d
    );
    expect(response.status).toBe(401);
    expect(d.readRing).not.toHaveBeenCalled();
  });

  it("bounds the body before any secret read", async () => {
    const d = deps();
    const response = await handleAuthorizationFacadeCredentialProjection(
      request({ lane: "candidate-a", nodeId: NODE_ID, pad: "x".repeat(600) }),
      d
    );
    expect(response.status).toBe(401);
    expect(d.readRing).not.toHaveBeenCalled();
  });

  it("rate limits before exchanging the OIDC credential", async () => {
    const d = deps({ consumeRateLimit: () => false });
    const response = await handleAuthorizationFacadeCredentialProjection(
      request(),
      d
    );
    expect(response.status).toBe(429);
    expect(d.readRing).not.toHaveBeenCalled();
  });
});
