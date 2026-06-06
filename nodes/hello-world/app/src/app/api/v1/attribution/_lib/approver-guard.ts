// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/attribution/_lib/approver-guard`
 * Purpose: Checks if a SIWE session wallet is in the ledger approvers allowlist.
 * Scope: For non-open epochs with pinned approvers, checks against the pinned set. For open epochs or when no epoch is provided, checks against repo-spec config. Does not perform database access.
 * Invariants: WRITE_ROUTES_APPROVER_GATED, APPROVERS_PINNED_AT_REVIEW
 * Side-effects: none
 * Links: docs/spec/attribution-ledger.md, .cogni/repo-spec.yaml
 * @internal
 */

import { NextResponse } from "next/server";
import { getLedgerApprovers } from "@/shared/config";
import type { RequestContext } from "@/shared/observability";
import { logRequestWarn } from "@/shared/observability";

/**
 * Returns a 403 response if the session wallet is not in the ledger approvers list.
 * Returns null if the caller is authorized.
 *
 * If `epoch` is provided and has pinned approvers (non-open), checks against those.
 * Otherwise falls back to repo-spec `getLedgerApprovers()`.
 */
export function checkApprover(
  ctx: RequestContext,
  walletAddress: string | null | undefined,
  epoch?: { readonly approvers: readonly string[] | null } | null
): NextResponse | null {
  if (!walletAddress) {
    logRequestWarn(ctx.log, { walletAddress }, "LEDGER_NO_WALLET");
    return NextResponse.json(
      { error: "Wallet address required" },
      { status: 403 }
    );
  }

  if (epoch && (!epoch.approvers || epoch.approvers.length === 0)) {
    logRequestWarn(ctx.log, {}, "LEDGER_NO_PINNED_APPROVERS");
    return NextResponse.json(
      { error: "Not authorized as ledger approver" },
      { status: 403 }
    );
  }

  const approvers = epoch?.approvers ?? getLedgerApprovers();

  const normalizedApprovers = approvers.map((a) => a.toLowerCase());

  if (!normalizedApprovers.includes(walletAddress.toLowerCase())) {
    logRequestWarn(
      ctx.log,
      { walletAddress: `${walletAddress.slice(0, 10)}...` },
      "LEDGER_NOT_APPROVER"
    );
    return NextResponse.json(
      { error: "Not authorized as ledger approver" },
      { status: 403 }
    );
  }

  return null;
}
