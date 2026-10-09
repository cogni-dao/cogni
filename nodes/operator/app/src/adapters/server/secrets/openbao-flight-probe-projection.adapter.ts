// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * OpenBao-backed reader for the control-vault flight-prober authority bucket.
 * GitHub's OIDC JWT is verified by OpenBao's dedicated, claim-bound role; the
 * application never verifies tokens itself and has no app-auth fallback.
 */

import { z } from "zod";

export const flightProbeLaneSchema = z.enum([
  "candidate-a",
  "preview",
  "production",
]);

export const flightProbeRingSchema = z
  .object({
    active: z.string().min(32).max(256),
    previous: z.string().min(32).max(256).nullable(),
  })
  .strict()
  .refine((ring) => ring.previous === null || ring.previous !== ring.active);

export type FlightProbeLane = z.infer<typeof flightProbeLaneSchema>;
export type FlightProbeRing = z.infer<typeof flightProbeRingSchema>;

interface OpenBaoLoginResponse {
  readonly auth?: { readonly client_token?: string };
}

interface OpenBaoKvResponse {
  readonly data?: { readonly data?: Record<string, unknown> };
}

export interface OpenBaoFlightProbeProjectionDeps {
  readonly addr: string;
  readonly fetchImpl?: typeof fetch;
}

export class OpenBaoFlightProbeProjectionAdapter {
  private readonly addr: string;
  private readonly fetchImpl: typeof fetch;

  constructor(deps: OpenBaoFlightProbeProjectionDeps) {
    this.addr = deps.addr.replace(/\/+$/, "");
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  async readRing(input: {
    readonly oidcJwt: string;
    readonly lane: FlightProbeLane;
    readonly nodeId: string;
  }): Promise<FlightProbeRing> {
    const login = await this.fetchImpl(
      `${this.addr}/v1/auth/github-actions/login`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role: `gha-${input.lane}-flight-probe-reader`,
          jwt: input.oidcJwt,
        }),
      }
    );
    if (!login.ok) throw projectionError("oidc_rejected");

    const loginBody = (await login.json()) as OpenBaoLoginResponse;
    const token = loginBody.auth?.client_token;
    if (!token) throw projectionError("oidc_rejected");

    // The role can read exactly this lane's authority bucket. Lane-wide access
    // is no broader than the GitHub Environment's existing target-vault
    // authority; the route returns only the requested catalog UUID field.
    const read = await this.fetchImpl(
      `${this.addr}/v1/cogni/data/${input.lane}/flight-prober`,
      { method: "GET", headers: { "x-vault-token": token } }
    );
    if (!read.ok) throw projectionError("projection_denied");

    const body = (await read.json()) as OpenBaoKvResponse;
    const encoded = body.data?.data?.[input.nodeId];
    if (typeof encoded !== "string" || encoded.length > 600) {
      throw projectionError("projection_denied");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(encoded);
    } catch {
      throw projectionError("projection_denied");
    }
    const ring = flightProbeRingSchema.safeParse(decoded);
    if (!ring.success) throw projectionError("projection_denied");
    return ring.data;
  }
}

function projectionError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
