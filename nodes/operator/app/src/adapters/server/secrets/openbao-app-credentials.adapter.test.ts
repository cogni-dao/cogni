// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { fingerprintAppPrivateKeyBase64 } from "@/shared/secrets/github-app-key-fingerprint";
import { OpenBaoAppCredentialsAdapter } from "./openbao-app-credentials.adapter";

const ADDR = "http://openbao.openbao.svc:8200";

const KEY_B64 = (() => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  return Buffer.from(pem, "utf-8").toString("base64");
})();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeAdapter(fetchImpl: typeof fetch): OpenBaoAppCredentialsAdapter {
  return new OpenBaoAppCredentialsAdapter({
    addr: ADDR,
    role: "candidate-a-node-secrets-writer",
    readServiceAccountToken: async () => "projected-sa-jwt",
    fetchImpl,
  });
}

function loginThen(
  handler: (
    url: string,
    init: RequestInit | undefined
  ) => Response | Promise<Response>
): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async (url, init) => {
    const u = String(url);
    if (u.endsWith("/auth/kubernetes/login")) {
      return jsonResponse({ auth: { client_token: "s.client" } });
    }
    return handler(u, init as RequestInit | undefined);
  });
}

describe("OpenBaoAppCredentialsAdapter.readStoredAppCredentialPair", () => {
  it("returns fingerprints only — never the key material", async () => {
    const fetchImpl = loginThen((u) => {
      expect(u).toBe(`${ADDR}/v1/cogni/data/candidate-a/operator`);
      return jsonResponse({
        data: {
          data: {
            GH_REVIEW_APP_ID: "3956976",
            GH_REVIEW_APP_PRIVATE_KEY_BASE64: KEY_B64,
            OTHER_SIBLING: "untouched",
          },
          metadata: { version: 7 },
        },
      });
    });
    const result =
      await makeAdapter(fetchImpl).readStoredAppCredentialPair("candidate-a");
    const expected = fingerprintAppPrivateKeyBase64(KEY_B64);
    expect(result).toEqual({
      configured: true,
      appId: "3956976",
      privateKeyFingerprint: expected.ok ? expected.fingerprint : "unreachable",
      version: 7,
    });
    // The serialized result must not leak any fragment of the material.
    expect(JSON.stringify(result)).not.toContain(KEY_B64.slice(0, 24));
  });

  it("reports unconfigured on 404 bucket and on a missing half of the pair", async () => {
    const notFound = loginThen(() => jsonResponse({}, 404));
    expect(
      await makeAdapter(notFound).readStoredAppCredentialPair("candidate-a")
    ).toEqual({ configured: false, version: 0 });

    const halfPair = loginThen(() =>
      jsonResponse({
        data: {
          data: { GH_REVIEW_APP_ID: "3956976" },
          metadata: { version: 3 },
        },
      })
    );
    expect(
      await makeAdapter(halfPair).readStoredAppCredentialPair("candidate-a")
    ).toEqual({ configured: false, appId: "3956976", version: 3 });
  });

  it("flags unparseable stored material without echoing it", async () => {
    const fetchImpl = loginThen(() =>
      jsonResponse({
        data: {
          data: {
            GH_REVIEW_APP_ID: "3956976",
            GH_REVIEW_APP_PRIVATE_KEY_BASE64:
              Buffer.from("rot").toString("base64"),
          },
          metadata: { version: 2 },
        },
      })
    );
    const result =
      await makeAdapter(fetchImpl).readStoredAppCredentialPair("candidate-a");
    expect(result).toEqual({
      configured: true,
      appId: "3956976",
      privateKeyUnparseable: true,
      version: 2,
    });
  });
});

describe("OpenBaoAppCredentialsAdapter.writeAppCredentialPair (C4)", () => {
  it("writes BOTH keys in ONE merge-patch with check-and-set at the observed version", async () => {
    const fetchImpl = loginThen((u, init) => {
      expect(u).toBe(`${ADDR}/v1/cogni/data/candidate-a/operator`);
      expect(init?.method).toBe("PATCH");
      expect(init?.headers).toMatchObject({
        "content-type": "application/merge-patch+json",
      });
      const body = JSON.parse(String(init?.body));
      expect(Object.keys(body.data).sort()).toEqual([
        "GH_REVIEW_APP_ID",
        "GH_REVIEW_APP_PRIVATE_KEY_BASE64",
      ]);
      expect(body.options).toEqual({ cas: 7 });
      return jsonResponse({ data: { version: 8 } });
    });
    const result = await makeAdapter(fetchImpl).writeAppCredentialPair({
      env: "candidate-a",
      appId: "3956976",
      privateKeyBase64: KEY_B64,
      expectedVersion: 7,
    });
    expect(result).toEqual({ version: 8 });
    // Exactly one data write happened (login + one PATCH).
    expect(fetchImpl.mock.calls.length).toBe(2);
  });

  it("creates a missing bucket via PUT with cas 0", async () => {
    const fetchImpl = loginThen((_u, init) => {
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      expect(body.options).toEqual({ cas: 0 });
      return jsonResponse({ data: { version: 1 } });
    });
    const result = await makeAdapter(fetchImpl).writeAppCredentialPair({
      env: "candidate-a",
      appId: "3956976",
      privateKeyBase64: KEY_B64,
      expectedVersion: 0,
    });
    expect(result).toEqual({ version: 1 });
  });

  it("surfaces a concurrent-writer CAS conflict as a typed failure, never success", async () => {
    const fetchImpl = loginThen(() =>
      jsonResponse({ errors: ["check-and-set parameter did not match"] }, 400)
    );
    await expect(
      makeAdapter(fetchImpl).writeAppCredentialPair({
        env: "candidate-a",
        appId: "3956976",
        privateKeyBase64: KEY_B64,
        expectedVersion: 7,
      })
    ).rejects.toMatchObject({ code: "openbao_cas_conflict", status: 400 });
  });

  it("surfaces OpenBao login/transport failures as typed errors", async () => {
    const loginFails = vi.fn<typeof fetch>(async () => jsonResponse({}, 403));
    await expect(
      makeAdapter(loginFails).writeAppCredentialPair({
        env: "candidate-a",
        appId: "3956976",
        privateKeyBase64: KEY_B64,
        expectedVersion: 1,
      })
    ).rejects.toMatchObject({ code: "openbao_login_failed" });

    const writeFails = loginThen(() => jsonResponse({}, 503));
    await expect(
      makeAdapter(writeFails).writeAppCredentialPair({
        env: "candidate-a",
        appId: "3956976",
        privateKeyBase64: KEY_B64,
        expectedVersion: 1,
      })
    ).rejects.toMatchObject({ code: "openbao_pair_write_failed", status: 503 });
  });
});
