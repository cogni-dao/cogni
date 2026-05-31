// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@lib/auth/mapping`
 * Purpose: Map NextAuth user identity to billing account + virtual key resolution.
 * Scope: Simple orchestration layer to keep mapping logic out of adapters/routes. Does not depend on framework.
 * Invariants: Delegates to AccountService; no framework dependencies.
 * Side-effects: IO (via injected AccountService)
 * Links: None
 * @public
 */

import type { AccountService, BillingAccount } from "@/ports";

export async function getOrCreateBillingAccountForUser(
  accountService: Pick<AccountService, "getOrCreateBillingAccountForUser">,
  params: { userId: string; walletAddress?: string; displayName?: string }
): Promise<BillingAccount> {
  return accountService.getOrCreateBillingAccountForUser(params);
}
