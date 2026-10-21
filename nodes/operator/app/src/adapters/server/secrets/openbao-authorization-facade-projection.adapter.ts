// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Read one lane/node authorization-facade authority ring through claim-bound GitHub OIDC. */

import { z } from "zod";

export const authorizationFacadeProjectionLaneSchema = z.enum([
  "candidate-a",
  "preview",
  "production",
]);

const token = z
  .string()
  .regex(
    /^cogni_naz_sk_v2_(candidate-a|preview|production)_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}_[0-9a-f]{64}$/
  );

export const authorizationFacadeAuthorityRingSchema = z
  .object({ active: token, previous: token.nullable() })
  .strict()
  .refine((ring) => ring.previous === null || ring.previous !== ring.active);

export type AuthorizationFacadeProjectionLane = z.infer<
  typeof authorizationFacadeProjectionLaneSchema
>;
export type AuthorizationFacadeAuthorityRing = z.infer<
  typeof authorizationFacadeAuthorityRingSchema
>;

export class OpenBaoAuthorizationFacadeProjectionAdapter {
  private readonly addr: string;
  private readonly fetchImpl: typeof fetch;

  constructor(input: {
    readonly addr: string;
    readonly fetchImpl?: typeof fetch;
  }) {
    this.addr = input.addr.replace(/\/+$/, "");
    this.fetchImpl = input.fetchImpl ?? fetch;
  }

  async readRing(input: {
    readonly oidcJwt: string;
    readonly lane: AuthorizationFacadeProjectionLane;
    readonly nodeId: string;
  }): Promise<AuthorizationFacadeAuthorityRing> {
    const login = await this.fetchImpl(
      `${this.addr}/v1/auth/github-actions/login`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role: `gha-${input.lane}-authorization-facade-reader`,
          jwt: input.oidcJwt,
        }),
        redirect: "error",
      }
    );
    if (!login.ok) throw new Error("authorization_projection_denied");
    if (!isJson(login)) throw new Error("authorization_projection_denied");
    const loginText = await boundedText(login, 16_384);
    const loginBody = JSON.parse(loginText) as {
      auth?: { client_token?: unknown };
    };
    const openBaoToken = loginBody.auth?.client_token;
    if (typeof openBaoToken !== "string" || openBaoToken.length > 8192) {
      throw new Error("authorization_projection_denied");
    }

    const read = await this.fetchImpl(
      `${this.addr}/v1/cogni/data/${input.lane}/authorization-facade`,
      {
        method: "GET",
        headers: { "x-vault-token": openBaoToken },
        redirect: "error",
      }
    );
    if (!read.ok) throw new Error("authorization_projection_denied");
    if (!isJson(read)) throw new Error("authorization_projection_denied");
    const bodyText = await boundedText(read, 4096);
    const body = JSON.parse(bodyText) as {
      data?: { data?: Record<string, unknown> };
    };
    const encoded = body.data?.data?.[input.nodeId];
    if (typeof encoded !== "string" || encoded.length > 600) {
      throw new Error("authorization_projection_denied");
    }
    const parsed = authorizationFacadeAuthorityRingSchema.safeParse(
      JSON.parse(encoded)
    );
    if (!parsed.success) throw new Error("authorization_projection_denied");
    const prefix = `cogni_naz_sk_v2_${input.lane}_${input.nodeId}_`;
    if (
      !parsed.data.active.startsWith(prefix) ||
      (parsed.data.previous !== null &&
        !parsed.data.previous.startsWith(prefix))
    ) {
      throw new Error("authorization_projection_denied");
    }
    return parsed.data;
  }
}

async function boundedText(
  response: Response,
  maxBytes: number
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isFinite(declared) || declared < 0 || declared > maxBytes) {
      throw new Error("authorization_projection_denied");
    }
  }
  if (!response.body) throw new Error("authorization_projection_denied");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("authorization_projection_denied");
    }
    chunks.push(value);
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total
  ).toString("utf8");
}

function isJson(response: Response): boolean {
  return /^application\/json(?:\s*;|$)/i.test(
    response.headers.get("content-type") ?? ""
  );
}
