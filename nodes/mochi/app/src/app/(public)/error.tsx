// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(public)/error`
 * Purpose: Error boundary for every route under the `(public)` route
 *   group. Catches RSC + render errors so anonymous users see a
 *   recovery UI instead of a blank page.
 * Scope: Client component (Next.js requires `"use client"` on error
 *   boundaries).
 * Invariants: `reset` re-attempts the failed segment without a hard
 *   reload. `digest` is forwarded as-is for cross-referencing with
 *   server-side Pino logs.
 * Side-effects: console.error of the digest.
 * Links: ./layout.tsx, ./loading.tsx,
 *   https://nextjs.org/docs/app/building-your-application/routing/error-handling
 * @public
 */

"use client";

import { useEffect } from "react";

interface PublicErrorProps {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}

export default function PublicError({ error, reset }: PublicErrorProps) {
  useEffect(() => {
    // biome-ignore lint/suspicious/noConsole: error boundary logging is the documented Next.js pattern
    console.error("(public) route error", {
      digest: error.digest,
      message: error.message,
    });
  }, [error]);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-4 px-4 py-16 text-center">
      <h2 className="font-semibold text-2xl">Something went wrong</h2>
      <p className="text-muted-foreground text-sm">
        We hit an unexpected error rendering this page. Refresh or try again
        below.
      </p>
      {error.digest ? (
        <p className="font-mono text-muted-foreground/70 text-xs">
          digest: {error.digest}
        </p>
      ) : null}
      <button
        type="button"
        onClick={reset}
        className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
      >
        Try again
      </button>
    </div>
  );
}
