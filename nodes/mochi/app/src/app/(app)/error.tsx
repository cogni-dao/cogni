// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/error`
 * Purpose: Error boundary for every route under the protected `(app)`
 *   route group. Catches RSC + render errors so the sidebar shell stays
 *   alive and the user sees a recovery UI instead of a blank page.
 * Scope: Client component (Next.js requires `"use client"` on error
 *   boundaries so React can hydrate the error state). Does not fetch
 *   data; only displays + offers reset.
 * Invariants: `reset` re-attempts the failed segment without a hard
 *   reload. `digest` is forwarded as-is for cross-referencing with
 *   server-side Pino logs.
 * Side-effects: console.error of the digest in development.
 * Links: ./layout.tsx, ./loading.tsx,
 *   https://nextjs.org/docs/app/building-your-application/routing/error-handling
 * @public
 */

"use client";

import { useEffect } from "react";

interface AppErrorProps {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}

export default function AppError({ error, reset }: AppErrorProps) {
  useEffect(() => {
    // Forward the digest so it lines up with the server-side Pino log.
    // biome-ignore lint/suspicious/noConsole: error boundary logging is the documented Next.js pattern
    console.error("(app) route error", {
      digest: error.digest,
      message: error.message,
    });
  }, [error]);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-12">
      <h2 className="font-semibold text-2xl">Something went wrong</h2>
      <p className="text-muted-foreground text-sm">
        We hit an unexpected error rendering this page. The sidebar still works
        — you can navigate elsewhere or retry below.
      </p>
      {error.digest ? (
        <p className="font-mono text-muted-foreground/70 text-xs">
          digest: {error.digest}
        </p>
      ) : null}
      <button
        type="button"
        onClick={reset}
        className="inline-flex w-fit items-center rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
      >
        Try again
      </button>
    </div>
  );
}
