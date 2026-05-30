// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(admin)/layout`
 * Purpose: Server-side gate + sidebar shell for DAO admin pages.
 * Scope: Server component. Resolves the SIWE session wallet, compares against `getLedgerApprovers()` (repo-spec `activity_ledger.approvers`), and redirects non-admins to `/dashboard`. Hands the approved request to the same client sidebar shell as `(app)/`. Does not handle data fetching.
 * Invariants: WRITE_ROUTES_APPROVER_GATED extended to page-level — admin pages are unreachable for non-approver wallets. Authentication is enforced by `proxy.ts` (login redirect); this layout enforces the admin-role check on top.
 * Side-effects: IO (auth session read, repo-spec read on first call), redirect
 * Links: src/app/api/v1/attribution/_lib/approver-guard.ts, src/shared/config/repoSpec.server.ts, .cogni/repo-spec.yaml
 * @public
 */

import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { getServerSessionUser } from "@/lib/auth/server";
import { getLedgerApprovers } from "@/shared/config";

import { AdminShell } from "./AdminShell";

export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}): Promise<ReactNode> {
  const user = await getServerSessionUser();
  const approvers = getLedgerApprovers();
  const wallet = user?.walletAddress?.toLowerCase() ?? null;

  if (!wallet || !approvers.includes(wallet)) {
    redirect("/dashboard");
  }

  return <AdminShell>{children}</AdminShell>;
}
