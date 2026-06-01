// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/auth/[...nextauth]`
 * Purpose: Expose NextAuth handlers for signin/session routes. Wraps handler with
 *   AsyncLocalStorage to propagate link intent to signIn callback.
 * Scope: On callback routes only, reads link_intent cookie, decodes JWT, populates linkIntentStore with pending or failed intent, delegates to NextAuth, and clears cookie via raw Set-Cookie header. Non-callback routes (/providers, /session, /signout) pass through unmodified. Does not perform DB verification or binding.
 * Invariants: Public infrastructure endpoint; session cookies managed by NextAuth.
 *   Link intent is fail-closed: if JWT decode fails, the intent is rejected (never ignored).
 * Side-effects: IO (NextAuth DB operations via Drizzle client, cookie read/clear)
 * Links: src/auth.ts, src/shared/auth/link-intent-store.ts
 * @public
 */

import { type LinkIntent, linkIntentStore } from "@cogni/node-shared";
import type { NextRequest } from "next/server";
import NextAuth from "next-auth";
import { decode } from "next-auth/jwt";
import { authOptions, authSecret } from "@/auth";

export const runtime = "nodejs";

const LINK_INTENT_COOKIE = "link_intent";
const LINK_INTENT_SALT = "link-intent";

const nextAuthHandler = NextAuth(authOptions);

function isCallbackRoute(segments: string[]): boolean {
  return segments[0] === "callback";
}

async function handler(
  req: NextRequest,
  context: { params: Promise<{ nextauth: string[] }> }
) {
  const segments = (await context.params).nextauth;
  const isCallback = isCallbackRoute(segments);

  // Check for link_intent cookie — only decode on callback routes
  const linkIntentCookie = req.cookies.get(LINK_INTENT_COOKIE)?.value;
  let linkIntent: LinkIntent | null = null;

  if (linkIntentCookie && isCallback) {
    try {
      const decoded = await decode({
        token: linkIntentCookie,
        secret: authSecret,
        salt: LINK_INTENT_SALT,
      });

      if (
        decoded?.purpose === "link_intent" &&
        typeof decoded.txId === "string" &&
        typeof decoded.userId === "string"
      ) {
        // Pass raw decoded data — auth.ts signIn callback will do the
        // atomic DB consume (it has getServiceDb access).
        linkIntent = { txId: decoded.txId, userId: decoded.userId };
      } else {
        linkIntent = { failed: true, reason: "invalid_jwt_payload" };
      }
    } catch {
      // Invalid/expired JWT token → fail closed
      linkIntent = { failed: true, reason: "invalid_jwt" };
    }
  }

  // Run NextAuth within AsyncLocalStorage context
  const res = await linkIntentStore.run(linkIntent, () =>
    nextAuthHandler(req, context)
  );

  // Clear link_intent cookie after processing (success or failure)
  // Use raw Set-Cookie header — works regardless of Response vs NextResponse
  if (isCallback && linkIntentCookie && res) {
    // biome-ignore lint/style/noProcessEnv: auth infra runs before serverEnv() is available
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    const headers = new Headers(res.headers);
    headers.append(
      "Set-Cookie",
      `${LINK_INTENT_COOKIE}=; HttpOnly; SameSite=Lax; Path=/api/auth/callback; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure}`
    );
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  }

  return res;
}

export { handler as GET, handler as POST };
