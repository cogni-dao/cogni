// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it, vi } from "vitest";
import { OpenBaoAuthorizationFacadeProjectionAdapter } from "./openbao-authorization-facade-projection.adapter";

const NODE_ID = "b927a9dd-6132-4fc9-a51e-e3cee2568e3c";
const ACTIVE = `cogni_naz_sk_v2_candidate-a_${NODE_ID}_${"a".repeat(64)}`;

describe("OpenBaoAuthorizationFacadeProjectionAdapter", () => {
  it("exchanges OIDC and reads only the exact lane authority bucket", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ auth: { client_token: "bao-token" } }), {
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              data: {
                [NODE_ID]: JSON.stringify({ active: ACTIVE, previous: null }),
              },
            },
          }),
          { headers: { "content-type": "application/json" } }
        )
      );
    const adapter = new OpenBaoAuthorizationFacadeProjectionAdapter({
      addr: "http://openbao.openbao.svc:8200",
      fetchImpl,
    });

    await expect(
      adapter.readRing({
        oidcJwt: "github-oidc-jwt",
        lane: "candidate-a",
        nodeId: NODE_ID,
      })
    ).resolves.toEqual({ active: ACTIVE, previous: null });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "http://openbao.openbao.svc:8200/v1/auth/github-actions/login",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        body: JSON.stringify({
          role: "gha-candidate-a-authorization-facade-reader",
          jwt: "github-oidc-jwt",
        }),
      })
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "http://openbao.openbao.svc:8200/v1/cogni/data/candidate-a/authorization-facade",
      expect.objectContaining({ method: "GET", redirect: "error" })
    );
  });

  it("fails closed without making the authority read when OIDC is rejected", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ errors: ["permission denied"] }), {
          status: 403,
          headers: { "content-type": "application/json" },
      })
    );
    const adapter = new OpenBaoAuthorizationFacadeProjectionAdapter({
      addr: "http://openbao.openbao.svc:8200",
      fetchImpl,
    });

    await expect(
      adapter.readRing({
        oidcJwt: "rejected-jwt",
        lane: "candidate-a",
        nodeId: NODE_ID,
      })
    ).rejects.toThrow("authorization_projection_denied");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a ring whose credential is for a foreign lane or node", async () => {
    const foreign = `cogni_naz_sk_v2_preview_${NODE_ID}_${"b".repeat(64)}`;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ auth: { client_token: "bao-token" } }), {
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              data: {
                [NODE_ID]: JSON.stringify({
                  active: foreign,
                  previous: null,
                }),
              },
            },
          }),
          { headers: { "content-type": "application/json" } }
        )
      );
    const adapter = new OpenBaoAuthorizationFacadeProjectionAdapter({
      addr: "http://openbao.openbao.svc:8200",
      fetchImpl,
    });

    await expect(
      adapter.readRing({
        oidcJwt: "github-oidc-jwt",
        lane: "candidate-a",
        nodeId: NODE_ID,
      })
    ).rejects.toThrow("authorization_projection_denied");
  });
});
