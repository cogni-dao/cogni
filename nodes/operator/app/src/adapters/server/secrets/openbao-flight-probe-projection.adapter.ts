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

interface OpenBaoKvResponse {
  readonly data?: { readonly data?: Record<string, unknown> };
}

const OPENBAO_LOGIN_MAX_BYTES = 16_384;
const OPENBAO_KV_MAX_BYTES = 262_144;
const openBaoLoginResponseSchema = z.object({
  auth: z.object({
    client_token: z
      .string()
      .min(16)
      .max(512)
      .regex(/^[A-Za-z0-9._-]+$/),
  }),
});

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
        redirect: "error",
      }
    );
    if (!login.ok) throw projectionError("oidc_rejected");

    const loginBody = openBaoLoginResponseSchema.safeParse(
      await readBoundedJson(login, OPENBAO_LOGIN_MAX_BYTES, "oidc_rejected")
    );
    if (!loginBody.success) throw projectionError("oidc_rejected");
    const token = loginBody.data.auth.client_token;

    // The role can read exactly this lane's authority bucket. Lane-wide access
    // is no broader than the GitHub Environment's existing target-vault
    // authority; the route returns only the requested catalog UUID field.
    const read = await this.fetchImpl(
      `${this.addr}/v1/cogni/data/${input.lane}/flight-prober`,
      {
        method: "GET",
        headers: { "x-vault-token": token },
        redirect: "error",
      }
    );
    if (!read.ok) throw projectionError("projection_denied");

    const body = (await readBoundedJson(
      read,
      OPENBAO_KV_MAX_BYTES,
      "projection_denied"
    )) as OpenBaoKvResponse;
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

async function readBoundedJson(
  response: Response,
  maxBytes: number,
  errorCode: string
): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase();
  if (
    contentType !== "application/json" &&
    !contentType?.startsWith("application/json;")
  ) {
    await cancelResponse(response);
    throw projectionError(errorCode);
  }

  const reader = response.body?.getReader();
  if (!reader) throw projectionError(errorCode);
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytesRead += chunk.value.byteLength;
      if (bytesRead > maxBytes) {
        throw projectionError(errorCode);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Preserve the uniform projection error even if upstream cancellation fails.
    }
    if (isProjectionError(error)) throw error;
    throw projectionError(errorCode);
  } finally {
    reader.releaseLock();
  }
}

async function cancelResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Preserve the uniform projection error even if upstream cancellation fails.
  }
}

function isProjectionError(error: unknown): error is Error & { code: string } {
  return (
    error instanceof Error &&
    typeof (error as { code?: unknown }).code === "string"
  );
}

function projectionError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
