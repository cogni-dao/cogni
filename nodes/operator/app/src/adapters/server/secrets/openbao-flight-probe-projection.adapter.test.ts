// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it, vi } from "vitest";
import { OpenBaoFlightProbeProjectionAdapter } from "./openbao-flight-probe-projection.adapter";

const NODE_ID = "b927a9dd-6132-4fc9-a51e-e3cee2568e3c";
const ACTIVE = "a".repeat(32);
const BAO_TOKEN = `hvs.${"b".repeat(64)}`;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function storedRingResponse(
  ring: unknown = { active: ACTIVE, previous: null }
): Response {
  return jsonResponse({
    data: { data: { [NODE_ID]: JSON.stringify(ring) } },
  });
}

function adapter(fetchImpl: typeof fetch): OpenBaoFlightProbeProjectionAdapter {
  return new OpenBaoFlightProbeProjectionAdapter({
    addr: "http://openbao.openbao.svc:8200",
    fetchImpl,
  });
}

function readRing(instance: OpenBaoFlightProbeProjectionAdapter) {
  return instance.readRing({
    oidcJwt: "github-oidc-jwt",
    lane: "candidate-a",
    nodeId: NODE_ID,
  });
}

function oversizedJsonResponse(byteLength: number): {
  readonly response: Response;
  readonly cancel: ReturnType<typeof vi.fn>;
} {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(byteLength));
    },
    cancel,
  });
  return {
    response: new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    cancel,
  };
}

describe("OpenBaoFlightProbeProjectionAdapter", () => {
  it("exchanges the OIDC JWT then reads only the lane authority bucket", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ auth: { client_token: BAO_TOKEN } })
      )
      .mockResolvedValueOnce(storedRingResponse());

    await expect(readRing(adapter(fetchImpl))).resolves.toEqual({
      active: ACTIVE,
      previous: null,
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "http://openbao.openbao.svc:8200/v1/auth/github-actions/login",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        body: JSON.stringify({
          role: "gha-candidate-a-flight-probe-reader",
          jwt: "github-oidc-jwt",
        }),
      })
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "http://openbao.openbao.svc:8200/v1/cogni/data/candidate-a/flight-prober",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        headers: { "x-vault-token": BAO_TOKEN },
      })
    );
  });

  it.each([
    "expired",
    "wrong-audience",
    "foreign-repo",
    "wrong-lane",
  ])("fails closed when OpenBao rejects %s identity", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ errors: ["permission denied"] }, 403));
    await expect(readRing(adapter(fetchImpl))).rejects.toMatchObject({
      code: "oidc_rejected",
    });
  });

  it("rejects a login redirect without forwarding the OIDC JWT", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 307,
        headers: { location: "https://attacker.invalid/login" },
      })
    );

    await expect(readRing(adapter(fetchImpl))).rejects.toMatchObject({
      code: "oidc_rejected",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ redirect: "error" })
    );
  });

  it("rejects a KV redirect without forwarding the OpenBao client token", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ auth: { client_token: BAO_TOKEN } })
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 308,
          headers: { location: "https://attacker.invalid/kv" },
        })
      );

    await expect(readRing(adapter(fetchImpl))).rejects.toMatchObject({
      code: "projection_denied",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({ redirect: "error" })
    );
  });

  it.each([
    ["missing", undefined],
    ["non-string", 42],
    ["too short", "short"],
    ["control character", `hvs.${"a".repeat(20)}\n${"b".repeat(20)}`],
    ["too long", `hvs.${"a".repeat(509)}`],
  ])("rejects a %s OpenBao client token", async (_case, clientToken) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ auth: { client_token: clientToken } })
      );

    await expect(readRing(adapter(fetchImpl))).rejects.toMatchObject({
      code: "oidc_rejected",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(["login", "kv"])(
    "requires a JSON content type on the %s response",
    async (stage) => {
      const nonJson = new Response("not-json", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
      const fetchImpl =
        stage === "login"
          ? vi.fn<typeof fetch>().mockResolvedValue(nonJson)
          : vi
              .fn<typeof fetch>()
              .mockResolvedValueOnce(
                jsonResponse({ auth: { client_token: BAO_TOKEN } })
              )
              .mockResolvedValueOnce(nonJson);

      await expect(readRing(adapter(fetchImpl))).rejects.toMatchObject({
        code: stage === "login" ? "oidc_rejected" : "projection_denied",
      });
    }
  );

  it.each(["login", "kv"])(
    "rejects malformed JSON from the %s response",
    async (stage) => {
      const malformed = new Response("{", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      const fetchImpl =
        stage === "login"
          ? vi.fn<typeof fetch>().mockResolvedValue(malformed)
          : vi
              .fn<typeof fetch>()
              .mockResolvedValueOnce(
                jsonResponse({ auth: { client_token: BAO_TOKEN } })
              )
              .mockResolvedValueOnce(malformed);

      await expect(readRing(adapter(fetchImpl))).rejects.toMatchObject({
        code: stage === "login" ? "oidc_rejected" : "projection_denied",
      });
    }
  );

  it("cancels an oversized login response before JSON parsing", async () => {
    const oversized = oversizedJsonResponse(16_385);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(oversized.response);

    await expect(readRing(adapter(fetchImpl))).rejects.toMatchObject({
      code: "oidc_rejected",
    });
    expect(oversized.cancel).toHaveBeenCalledOnce();
  });

  it("cancels an oversized KV response before JSON parsing", async () => {
    const oversized = oversizedJsonResponse(262_145);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ auth: { client_token: BAO_TOKEN } })
      )
      .mockResolvedValueOnce(oversized.response);

    await expect(readRing(adapter(fetchImpl))).rejects.toMatchObject({
      code: "projection_denied",
    });
    expect(oversized.cancel).toHaveBeenCalledOnce();
  });

  it("rejects malformed or oversized stored rings", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ auth: { client_token: BAO_TOKEN } })
      )
      .mockResolvedValueOnce(
        storedRingResponse({ active: "short", previous: null })
      );

    await expect(readRing(adapter(fetchImpl))).rejects.toMatchObject({
      code: "projection_denied",
    });
  });
});
