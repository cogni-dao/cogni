// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/profile/LinkProviderButton`
 * Purpose: Starts an OAuth account link from the profile page, exactly once per click burst.
 * Scope: Client button. Creates the server-side link transaction, then hands off to NextAuth
 *   sign-in. Does not decide the link outcome.
 * Invariants:
 *   - LINK_SUBMITS_ONCE: a second click while a link is in flight is ignored. A double
 *     submit consumed the link intent and drove a second, intent-less callback (bug.5603).
 *   - OUTCOME_IS_SERVER_TRUTH: the callbackUrl never claims success. The server's signIn
 *     callback redirects to `?linked=` / `?error=` itself.
 * Side-effects: IO (POST /api/auth/link/{provider}, NextAuth signIn redirect)
 * Links: src/auth.ts, src/app/api/auth/link/[provider]/route.ts, bug.5603
 * @public
 */

"use client";

import { signIn } from "next-auth/react";
import type { ReactElement } from "react";
import { useRef, useState } from "react";

import { Button } from "@/components";

/** Neutral landing page: carries no success claim. */
export const LINK_CALLBACK_URL = "/profile";

export function LinkProviderButton({
  provider,
}: {
  provider: string;
}): ReactElement {
  // A ref closes the same-tick window that state alone leaves open.
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);

  async function start(): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      const res = await fetch(`/api/auth/link/${provider}`, {
        method: "POST",
      });
      if (!res.ok) {
        inFlight.current = false;
        setPending(false);
        return;
      }
      // Stay in flight: the browser is navigating to the provider.
      await signIn(provider, { callbackUrl: LINK_CALLBACK_URL });
    } catch {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() => {
        void start();
      }}
    >
      Link
    </Button>
  );
}
