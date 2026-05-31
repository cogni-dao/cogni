// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(public)/AuthRedirect`
 * Purpose: Client-side auth transition gate for SIWE sign-in on public pages.
 * Scope: Watches NextAuth session status; does not enforce auth policy or access control.
 *   When authenticated, renders a full-screen overlay and hard-navigates to /chat
 *   so middleware/RSC run on the new request. Server remains the routing authority.
 * Invariants: No-op when session is loading or unauthenticated; overlay prevents flash.
 * Side-effects: IO (hard navigation via window.location.replace)
 * Links: src/proxy.ts (server-side authority), src/app/(public)/page.tsx
 * @public
 */

"use client";

import { useSession } from "next-auth/react";
import { useEffect, useState } from "react";

export function AuthRedirect(): React.JSX.Element | null {
  const { status } = useSession();
  const [redirecting, setRedirecting] = useState(false);

  useEffect(() => {
    if (status === "authenticated") {
      setRedirecting(true);
      window.location.replace("/chat");
    }
  }, [status]);

  if (!redirecting) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
      <p className="text-muted-foreground text-sm">Redirecting…</p>
    </div>
  );
}
