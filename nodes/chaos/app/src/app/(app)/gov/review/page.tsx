// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/gov/review/page`
 * Purpose: Server entrypoint for the epoch review admin page with approver gate.
 * Scope: Server component. Checks SIWE session wallet against ledger approvers. Passes isApprover prop to client view. Does not perform data fetching or mutations.
 * Invariants: WRITE_ROUTES_APPROVER_GATED — page-level access gating. Auth enforced by (app) layout guard.
 * Side-effects: IO (auth session read, config read)
 * Links: src/app/api/v1/attribution/_lib/approver-guard.ts
 * @public
 */

import type { ReactElement } from "react";

import { getServerSessionUser } from "@/lib/auth/server";
import { getLedgerApprovers } from "@/shared/config";

import { ReviewView } from "./view";

export default async function ReviewPage(): Promise<ReactElement> {
  const user = await getServerSessionUser();
  const approvers = getLedgerApprovers();

  const isApprover =
    !!user?.walletAddress &&
    approvers.includes(user.walletAddress.toLowerCase());

  return <ReviewView isApprover={isApprover} />;
}
