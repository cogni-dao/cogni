// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(admin)/page`
 * Purpose: Index landing for the `(admin)/` route group — links to existing admin-shaped surfaces.
 * Scope: Server component. Access gating handled upstream by `(admin)/layout.tsx`.
 * Invariants: Lists only links that point to surfaces with their own server-side approver enforcement; this page does not duplicate signing or governance logic.
 * Side-effects: none
 * Links: src/app/(admin)/layout.tsx, src/app/(app)/gov/review/page.tsx
 * @public
 */

import { FileSignature, Shield } from "lucide-react";
import Link from "next/link";
import type { ReactElement } from "react";

export default function AdminIndexPage(): ReactElement {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Shield className="h-7 w-7 text-primary" />
        <div>
          <h1 className="font-bold text-3xl tracking-tight">DAO Admin</h1>
          <p className="text-muted-foreground text-sm">
            Surfaces gated by the repo-spec approver allowlist (
            <code>activity_ledger.approvers</code>).
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Link
          href="/gov/review"
          className="group flex flex-col gap-2 rounded-lg border bg-card p-4 transition hover:border-primary"
        >
          <div className="flex items-center gap-2">
            <FileSignature className="h-5 w-5 text-muted-foreground group-hover:text-primary" />
            <span className="font-semibold">Epoch Review &amp; Sign</span>
          </div>
          <p className="text-muted-foreground text-sm">
            Review pending epoch ledgers, adjust per-contribution weights, and
            sign to finalize. EIP-712 typed-data flow.
          </p>
        </Link>
      </div>
    </div>
  );
}
