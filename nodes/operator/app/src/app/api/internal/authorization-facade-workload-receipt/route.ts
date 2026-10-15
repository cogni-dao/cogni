// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Workload-originated proof that a newly booted node process loaded its active
 * authorization-facade credential and can execute a semantic facade check.
 * The receipt contains only a challenge, boot identity, build SHA, and decision.
 */

import { randomUUID, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bootId = randomUUID();
const CHALLENGE = /^[0-9a-f]{64}$/;
const BUILD_SHA = /^[0-9a-f]{40}$/;
const MAX_RESPONSE_BYTES = 8 * 1024;

function bearerToken(request: Request): string | undefined {
  const value = request.headers.get("authorization");
  if (!value?.startsWith("Bearer ")) return undefined;
  const token = value.slice("Bearer ".length);
  return token.length > 0 && token.trim() === token ? token : undefined;
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > MAX_RESPONSE_BYTES
    ) {
      throw new Error("invalid semantic response length");
    }
  }
  if (!response.body) throw new Error("missing semantic response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("semantic response exceeds bound");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
}

export async function POST(request: Request): Promise<Response> {
  const challenge = request.headers.get("x-cogni-rotation-challenge");
  if (!challenge || !CHALLENGE.test(challenge) || request.body !== null) {
    return NextResponse.json(
      { error: "invalid_request" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  // Validate every attacker-controlled field before reading either secret.
  const presented = bearerToken(request);
  const loaded = process.env.AUTHORIZATION_FACADE_TOKEN;
  if (!presented || !loaded || !sameSecret(presented, loaded)) {
    return NextResponse.json(
      { error: "invalid_service_credential" },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }

  const buildSha = process.env.APP_BUILD_SHA;
  const ownOriginRaw = process.env.NEXTAUTH_URL;
  if (!buildSha || !BUILD_SHA.test(buildSha) || !ownOriginRaw) {
    return NextResponse.json(
      { error: "receipt_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    const ownOrigin = new URL(ownOriginRaw);
    const requestOrigin = new URL(request.url);
    if (
      ownOrigin.protocol !== "https:" ||
      ownOrigin.username ||
      ownOrigin.password ||
      ownOrigin.pathname !== "/" ||
      ownOrigin.search ||
      ownOrigin.hash ||
      ownOrigin.origin !== requestOrigin.origin
    ) {
      throw new Error("invalid workload origin");
    }
    const semanticResponse = await fetch(
      new URL("/api/v1/authorization/check", ownOrigin),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${loaded}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          actor: { kind: "user", id: "00000000-0000-4000-8000-000000000001" },
          billingAccountId: "00000000-0000-4000-8000-000000000002",
          context: { runId: `authorization-rotation:${challenge}` },
        }),
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      }
    );
    if (semanticResponse.status !== 200 && semanticResponse.status !== 403) {
      throw new Error("semantic check unavailable");
    }
    if (
      !/^application\/json(?:\s*;|$)/i.test(
        semanticResponse.headers.get("content-type") ?? ""
      )
    ) {
      throw new Error("invalid semantic response type");
    }
    const semantic = await boundedJson(semanticResponse);
    if (
      !semantic ||
      typeof semantic !== "object" ||
      Array.isArray(semantic) ||
      !("code" in semantic) ||
      (semantic.code !== "authz_allowed" && semantic.code !== "authz_denied")
    ) {
      throw new Error("invalid semantic decision");
    }
    return NextResponse.json(
      { challenge, bootId, buildSha, semanticCode: semantic.code },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json(
      { error: "receipt_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
