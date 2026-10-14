// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  GithubAppIdentityAdapter,
  mintAppJwt,
} from "./github-app-identity.adapter";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const KEY_B64 = Buffer.from(PEM, "utf-8").toString("base64");
const APP_ID = "3956976";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeAdapter(fetchImpl: typeof fetch): GithubAppIdentityAdapter {
  return new GithubAppIdentityAdapter({
    baseUrl: "https://api.github.test",
    fetchImpl,
    nowMs: () => 1_700_000_000_000,
  });
}

function happyGithub(overrides?: {
  appId?: number;
  hookUrl?: string;
  hookStatus?: number;
  owners?: string[];
}): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async (url, init) => {
    const u = String(url);
    // C1 pin: this adapter is READ-ONLY against GitHub. Any non-GET is a test failure.
    expect(init?.method).toBe("GET");
    if (u.endsWith("/app")) {
      return jsonResponse({
        id: overrides?.appId ?? Number(APP_ID),
        slug: "cogni-operator-test",
      });
    }
    if (u.endsWith("/app/hook/config")) {
      if (overrides?.hookStatus) return jsonResponse({}, overrides.hookStatus);
      return jsonResponse({
        url:
          overrides?.hookUrl ??
          "https://test.cognidao.org/api/internal/webhooks/github",
      });
    }
    if (u.includes("/app/installations")) {
      return jsonResponse(
        (overrides?.owners ?? ["cogni-test-org"]).map((login) => ({
          account: { login },
        }))
      );
    }
    throw new Error(`unexpected URL ${u}`);
  });
}

describe("mintAppJwt", () => {
  it("mints a verifiable RS256 JWT with iss=appId, backdated iat, <10m expiry", () => {
    const jwt = mintAppJwt(APP_ID, PEM, 1_700_000_000_000);
    const [h, p, s] = jwt.split(".");
    expect(
      JSON.parse(Buffer.from(h as string, "base64url").toString())
    ).toEqual({ alg: "RS256", typ: "JWT" });
    const payload = JSON.parse(
      Buffer.from(p as string, "base64url").toString()
    );
    expect(payload.iss).toBe(APP_ID);
    expect(payload.iat).toBe(1_700_000_000 - 60);
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
    const ok = verify(
      "RSA-SHA256",
      Buffer.from(`${h}.${p}`),
      createPublicKey(PEM),
      Buffer.from(s as string, "base64url")
    );
    expect(ok).toBe(true);
  });
});

describe("GithubAppIdentityAdapter.verifyAppCredential", () => {
  it("verifies a sound pair: identity, webhook host, installation owners — GETs only", async () => {
    const fetchImpl = happyGithub();
    const result = await makeAdapter(fetchImpl).verifyAppCredential({
      appId: APP_ID,
      privateKeyBase64: KEY_B64,
    });
    expect(result).toEqual({
      kind: "verified",
      appId: APP_ID,
      appSlug: "cogni-operator-test",
      webhookHost: "test.cognidao.org",
      installationOwners: ["cogni-test-org"],
    });
    // The Bearer header carries a JWT, never the PEM/base64 material.
    for (const [, init] of fetchImpl.mock.calls) {
      const auth = (init?.headers as Record<string, string>).authorization;
      expect(auth).toMatch(/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./);
      expect(auth).not.toContain(KEY_B64.slice(0, 24));
    }
  });

  it("returns invalid_key_material for undecodable input without any network call", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await makeAdapter(fetchImpl).verifyAppCredential({
      appId: APP_ID,
      privateKeyBase64: Buffer.from("garbage").toString("base64"),
    });
    expect(result).toEqual({ kind: "invalid", reason: "invalid_key_material" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps a GitHub 401 to unauthenticated (revoked/foreign key)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({}, 401));
    const result = await makeAdapter(fetchImpl).verifyAppCredential({
      appId: APP_ID,
      privateKeyBase64: KEY_B64,
    });
    expect(result).toEqual({ kind: "invalid", reason: "unauthenticated" });
  });

  it("maps an App-id mismatch to identity_mismatch (key belongs to another App)", async () => {
    const fetchImpl = happyGithub({ appId: 1111111 });
    const result = await makeAdapter(fetchImpl).verifyAppCredential({
      appId: APP_ID,
      privateKeyBase64: KEY_B64,
    });
    expect(result).toEqual({ kind: "invalid", reason: "identity_mismatch" });
  });

  it("distinguishes transport failure from credential invalidity (C2)", async () => {
    const network = vi.fn<typeof fetch>(async () => {
      throw new Error("ECONNRESET");
    });
    expect(
      await makeAdapter(network).verifyAppCredential({
        appId: APP_ID,
        privateKeyBase64: KEY_B64,
      })
    ).toEqual({ kind: "transport_failure" });

    const fiveHundred = vi.fn<typeof fetch>(async () => jsonResponse({}, 502));
    expect(
      await makeAdapter(fiveHundred).verifyAppCredential({
        appId: APP_ID,
        privateKeyBase64: KEY_B64,
      })
    ).toEqual({ kind: "transport_failure", status: 502 });
  });

  it("tolerates a 404 hook config (no webhook configured) as webhookHost null", async () => {
    const fetchImpl = happyGithub({ hookStatus: 404 });
    const result = await makeAdapter(fetchImpl).verifyAppCredential({
      appId: APP_ID,
      privateKeyBase64: KEY_B64,
    });
    expect(result).toMatchObject({ kind: "verified", webhookHost: null });
  });
});
