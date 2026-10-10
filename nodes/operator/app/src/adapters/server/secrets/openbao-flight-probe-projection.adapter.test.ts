// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it, vi } from "vitest";
import { OpenBaoFlightProbeProjectionAdapter } from "./openbao-flight-probe-projection.adapter";

const NODE_ID = "b927a9dd-6132-4fc9-a51e-e3cee2568e3c";
const ACTIVE = "a".repeat(32);

describe("OpenBaoFlightProbeProjectionAdapter", () => {
  it("exchanges the OIDC JWT then reads only the lane authority bucket", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ auth: { client_token: "bao-token" } }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              data: {
                [NODE_ID]: JSON.stringify({
                  active: ACTIVE,
                  previous: null,
                }),
              },
            },
          }),
          { status: 200 }
        )
      );
    const adapter = new OpenBaoFlightProbeProjectionAdapter({
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
        body: JSON.stringify({
          role: "gha-candidate-a-flight-probe-reader",
          jwt: "github-oidc-jwt",
        }),
      })
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "http://openbao.openbao.svc:8200/v1/cogni/data/candidate-a/flight-prober",
      expect.objectContaining({ method: "GET" })
    );
  });

  it.each([
    "expired",
    "wrong-audience",
    "foreign-repo",
    "wrong-lane",
  ])("fails closed when OpenBao rejects %s identity", async () => {
    const adapter = new OpenBaoFlightProbeProjectionAdapter({
      addr: "http://openbao.openbao.svc:8200",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ errors: ["permission denied"] }), {
          status: 403,
        })
      ),
    });
    await expect(
      adapter.readRing({
        oidcJwt: "rejected-jwt",
        lane: "candidate-a",
        nodeId: NODE_ID,
      })
    ).rejects.toMatchObject({ code: "oidc_rejected" });
  });

  it("rejects malformed or oversized stored rings", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ auth: { client_token: "bao-token" } }))
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              data: {
                [NODE_ID]: JSON.stringify({
                  active: "short",
                  previous: null,
                }),
              },
            },
          })
        )
      );
    const adapter = new OpenBaoFlightProbeProjectionAdapter({
      addr: "http://openbao.openbao.svc:8200",
      fetchImpl,
    });
    await expect(
      adapter.readRing({
        oidcJwt: "github-oidc-jwt",
        lane: "candidate-a",
        nodeId: NODE_ID,
      })
    ).rejects.toMatchObject({ code: "projection_denied" });
  });
});
