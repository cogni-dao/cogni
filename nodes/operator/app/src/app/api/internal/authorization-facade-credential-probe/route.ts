// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Credential-only probe for rotation proof. It exposes no authorization data. */

import { NextResponse } from "next/server";

import { authenticateAuthorizationFacadeRequest } from "@/app/_lib/authorization-facade-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const auth = await authenticateAuthorizationFacadeRequest(request);
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.errorCode },
      { status: auth.status, headers: { "Cache-Control": "no-store" } }
    );
  }
  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}
