// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Control-only, GitHub-OIDC-bound projection of one authorization-facade ring. */

import { NextResponse } from "next/server";
import { z } from "zod";

import { createAuthorizationFacadeProjectionCapability } from "@/bootstrap/authorization-facade-projection";
import {
  TokenBucketRateLimiter,
  wrapRouteHandlerWithLogging,
} from "@/bootstrap/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_AUTH_HEADER = 8192;
const MAX_BODY_BYTES = 512;
const requestSchema = z
  .object({
    lane: z.enum(["candidate-a", "preview", "production"]),
    nodeId: z.string().uuid(),
  })
  .strict();
const responseSchema = z
  .object({
    active: z
      .string()
      .regex(
        /^cogni_naz_sk_v2_(candidate-a|preview|production)_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}_[0-9a-f]{64}$/
      ),
    previous: z
      .string()
      .regex(
        /^cogni_naz_sk_v2_(candidate-a|preview|production)_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}_[0-9a-f]{64}$/
      )
      .nullable(),
  })
  .strict()
  .refine((ring) => ring.previous === null || ring.previous !== ring.active);
const limiter = new TokenBucketRateLimiter({
  maxTokens: 30,
  refillRate: 30 / 60,
  burstSize: 5,
});

export type AuthorizationFacadeProjectionDeps = {
  readonly isControl: () => boolean;
  readonly isCatalogNode: (nodeId: string) => boolean;
  readonly consumeRateLimit: () => boolean;
  readonly readRing: (input: {
    oidcJwt: string;
    lane: "candidate-a" | "preview" | "production";
    nodeId: string;
  }) => Promise<{ active: string; previous: string | null }>;
  readonly audit: (event: {
    lane?: string;
    nodeId?: string;
    outcome: "allowed" | "denied" | "rate_limited";
  }) => void;
};

function response(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header || header.length > MAX_AUTH_HEADER) return null;
  return /^Bearer ([^\s]+)$/.exec(header)?.[1] ?? null;
}

async function boundedJson(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("missing body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("body too large");
    }
    chunks.push(value);
  }
  return JSON.parse(
    Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      total
    ).toString("utf8")
  );
}

export async function handleAuthorizationFacadeCredentialProjection(
  request: Request,
  deps: AuthorizationFacadeProjectionDeps
): Promise<NextResponse<Record<string, unknown>>> {
  const tls =
    request.headers.get("x-forwarded-proto") === "https" ||
    (request.headers.get("x-forwarded-proto") === null &&
      new URL(request.url).protocol === "https:");
  if (!tls || !deps.isControl()) {
    deps.audit({ outcome: "denied" });
    return response(401, { error: "unauthorized" });
  }
  if (!deps.consumeRateLimit()) {
    deps.audit({ outcome: "rate_limited" });
    return response(429, { error: "rate_limited" });
  }
  const oidcJwt = bearer(request);
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  const contentLength = request.headers.get("content-length");
  const declared = contentLength === null ? null : Number(contentLength);
  if (
    !oidcJwt ||
    !contentType.startsWith("application/json") ||
    (declared !== null &&
      (!Number.isFinite(declared) || declared < 0 || declared > MAX_BODY_BYTES))
  ) {
    deps.audit({ outcome: "denied" });
    return response(401, { error: "unauthorized" });
  }
  let body: unknown;
  try {
    body = await boundedJson(request);
  } catch {
    deps.audit({ outcome: "denied" });
    return response(401, { error: "unauthorized" });
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success || !deps.isCatalogNode(parsed.data.nodeId)) {
    deps.audit({ outcome: "denied" });
    return response(401, { error: "unauthorized" });
  }
  try {
    const ring = responseSchema.parse(
      await deps.readRing({ oidcJwt, ...parsed.data })
    );
    const prefix = `cogni_naz_sk_v2_${parsed.data.lane}_${parsed.data.nodeId}_`;
    if (
      !ring.active.startsWith(prefix) ||
      (ring.previous !== null && !ring.previous.startsWith(prefix))
    ) {
      throw new Error("foreign credential");
    }
    deps.audit({ ...parsed.data, outcome: "allowed" });
    return response(200, ring);
  } catch {
    deps.audit({ ...parsed.data, outcome: "denied" });
    return response(401, { error: "unauthorized" });
  }
}

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "authorization-facade-credentials.internal",
    auth: { mode: "none" },
  },
  async (ctx, request) => {
    const capability = createAuthorizationFacadeProjectionCapability();
    return handleAuthorizationFacadeCredentialProjection(request, {
      isControl: capability.isControl,
      isCatalogNode: capability.isCatalogNode,
      consumeRateLimit: () =>
        limiter.consume("authorization-facade-projection"),
      readRing: capability.readRing,
      audit: (event) =>
        ctx.log.info(
          { ...event, routeId: "authorization-facade-credentials.internal" },
          "authorization-facade credential projection"
        ),
    });
  }
);
