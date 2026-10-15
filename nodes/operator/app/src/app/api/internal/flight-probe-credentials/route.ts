// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Control-only GitHub OIDC projection seam for node-local flight-prober rings.
 * OpenBao owns JWT verification and claim binding; this route has no app-auth
 * fallback and never logs tokens, response bodies, or credential values.
 */

import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createFlightProbeProjectionCapability } from "@/bootstrap/flight-probe-projection";
import {
  extractClientIp,
  TokenBucketRateLimiter,
  wrapRouteHandlerWithLogging,
} from "@/bootstrap/http";
import { EVENT_NAMES, logEvent } from "@/shared/observability";
import {
  type FlightProbeProjectionErrorCode,
  flightProbeRingSchema,
  isFlightProbeProjectionError,
} from "@/shared/secrets/flight-probe-credential";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_AUTH_HEADER = 8192;
const MAX_BODY_BYTES = 512;
const RequestSchema = z
  .object({
    lane: z.enum(["candidate-a", "preview", "production"]),
    nodeId: z.string().uuid(),
  })
  .strict();
const limiter = new TokenBucketRateLimiter({
  maxTokens: 30,
  refillRate: 30 / 60,
  burstSize: 5,
});

export type ProjectionDeps = {
  readonly isControl: () => boolean;
  readonly isCatalogNode: (nodeId: string) => boolean;
  readonly consumeRateLimit: (request: Request) => boolean;
  readonly readRing: (input: {
    oidcJwt: string;
    lane: "candidate-a" | "preview" | "production";
    nodeId: string;
  }) => Promise<{ active: string; previous: string | null }>;
  readonly audit: (event: {
    lane?: string;
    nodeId?: string;
    status: 200 | 401 | 429;
    durationMs: number;
    outcome: "success" | "error";
    errorCode?:
      | "unauthorized"
      | "rate_limited"
      | FlightProbeProjectionErrorCode;
  }) => void;
};

function response(
  status: number,
  body: Record<string, unknown>
): NextResponse<Record<string, unknown>> {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header || header.length > MAX_AUTH_HEADER) return null;
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match?.[1] ?? null;
}

function isTls(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded !== null) return forwarded === "https";
  return new URL(request.url).protocol === "https:";
}

async function readBoundedJson(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("request body is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("request body exceeds bound");
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

export async function handleFlightProbeCredentialProjection(
  request: Request,
  deps: ProjectionDeps
): Promise<NextResponse<Record<string, unknown>>> {
  const startedAt = performance.now();
  const audit = (
    event: Omit<Parameters<ProjectionDeps["audit"]>[0], "durationMs">
  ) =>
    deps.audit({
      ...event,
      durationMs: Math.round(performance.now() - startedAt),
    });

  if (!isTls(request) || !deps.isControl()) {
    audit({ status: 401, outcome: "error", errorCode: "unauthorized" });
    return response(401, { error: "unauthorized" });
  }
  if (!deps.consumeRateLimit(request)) {
    audit({ status: 429, outcome: "error", errorCode: "rate_limited" });
    return response(429, { error: "rate_limited" });
  }
  const oidcJwt = bearer(request);
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  const contentLength = request.headers.get("content-length");
  const declaredLength = contentLength === null ? null : Number(contentLength);
  if (
    !oidcJwt ||
    !contentType.startsWith("application/json") ||
    (declaredLength !== null &&
      (!Number.isFinite(declaredLength) || declaredLength > MAX_BODY_BYTES))
  ) {
    audit({ status: 401, outcome: "error", errorCode: "unauthorized" });
    return response(401, { error: "unauthorized" });
  }

  let body: unknown;
  try {
    body = await readBoundedJson(request);
  } catch {
    audit({ status: 401, outcome: "error", errorCode: "unauthorized" });
    return response(401, { error: "unauthorized" });
  }
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success || !deps.isCatalogNode(parsed.data.nodeId)) {
    audit({ status: 401, outcome: "error", errorCode: "unauthorized" });
    return response(401, { error: "unauthorized" });
  }

  try {
    const ring = flightProbeRingSchema.parse(
      await deps.readRing({ oidcJwt, ...parsed.data })
    );
    audit({ ...parsed.data, status: 200, outcome: "success" });
    return response(200, ring);
  } catch (error) {
    audit({
      ...parsed.data,
      status: 401,
      outcome: "error",
      errorCode: projectionFailureCode(error),
    });
    return response(401, { error: "unauthorized" });
  }
}

function projectionFailureCode(error: unknown): FlightProbeProjectionErrorCode {
  if (isFlightProbeProjectionError(error)) return error.code;
  if (error instanceof z.ZodError) return "projection_denied";
  return "upstream_unavailable";
}

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "flight-probe-credentials.internal", auth: { mode: "none" } },
  async (ctx, request) => {
    const capability = createFlightProbeProjectionCapability();
    return handleFlightProbeCredentialProjection(request, {
      isControl: capability.isControl,
      isCatalogNode: capability.isCatalogNode,
      consumeRateLimit: (req) =>
        limiter.consume(extractClientIp(req as NextRequest)),
      readRing: capability.readRing,
      audit: (event) =>
        logEvent(ctx.log, EVENT_NAMES.FLIGHT_PROBE_PROJECTION_COMPLETE, {
          reqId: ctx.reqId,
          routeId: ctx.routeId,
          ...event,
        }),
    });
  }
);
