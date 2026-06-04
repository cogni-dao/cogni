// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/auth/link/[provider]`
 * Purpose: Account linking setup endpoint. Creates a DB-backed link transaction and
 *   sets a signed link_intent cookie. The client then calls signIn() to start OAuth.
 * Scope: POST-only. Requires existing session. Does not initiate OAuth, perform binding, or redirect — only sets the link_intent cookie (path=/api/auth/callback, 5-min TTL).
 * Invariants: LINKING_IS_EXPLICIT — only authenticated users can initiate linking.
 *   Cookie is time-limited (5min), HttpOnly, Secure, SameSite=Lax. DB transaction is the authority.
 * Side-effects: IO (DB insert via auth helper, cookie set)
 * Links: src/app/api/auth/[...nextauth]/route.ts, src/shared/auth/link-intent-store.ts
 * @public
 */

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { encode } from "next-auth/jwt";

import { authSecret, createLinkTransaction } from "@/auth";
import { getServerSessionUser } from "@/lib/auth/server";

export const runtime = "nodejs";

const ALLOWED_PROVIDERS = new Set(["github", "discord", "google"]);
const LINK_INTENT_COOKIE = "link_intent";
const LINK_INTENT_SALT = "link-intent";
const LINK_INTENT_TTL = 5 * 60; // 5 minutes

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;

  if (!ALLOWED_PROVIDERS.has(provider)) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
  }

  // Require existing session
  const session = await getServerSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Create DB-backed link transaction (the authority for fail-closed verification)
  const txId = await createLinkTransaction(session.id, provider);

  // Create a signed JWT containing txId + userId (tamper-proof transport)
  const linkToken = await encode({
    token: {
      txId,
      userId: session.id,
      purpose: "link_intent",
    },
    secret: authSecret,
    salt: LINK_INTENT_SALT,
    maxAge: LINK_INTENT_TTL,
  });

  // Set HttpOnly cookie — SameSite=Lax allows top-level navigation (OAuth redirect)
  const cookieStore = await cookies();
  cookieStore.set(LINK_INTENT_COOKIE, linkToken, {
    httpOnly: true,
    // biome-ignore lint/style/noProcessEnv: auth infra runs before serverEnv() is available
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/auth/callback",
    maxAge: LINK_INTENT_TTL,
  });

  return NextResponse.json({ ok: true });
}
