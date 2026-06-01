// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/healthchecks`
 * Purpose: Startup healthchecks that fail fast if required infrastructure is missing.
 * Scope: Verifies system tenant billing account exists at startup. Does not perform ongoing health monitoring.
 * Invariants: SYSTEM_TENANT_STARTUP_CHECK — app must not start without system tenant billing account.
 * Side-effects: IO (database query via ServiceAccountService port)
 * Links: docs/spec/system-tenant.md
 * @public
 */

import { COGNI_SYSTEM_BILLING_ACCOUNT_ID } from "@cogni/node-shared";
import type { ServiceAccountService } from "@/ports";

/**
 * Verify the system tenant billing account exists.
 * Per SYSTEM_TENANT_STARTUP_CHECK: fail fast with clear error if missing.
 */
export async function verifySystemTenant(
  serviceAccountService: ServiceAccountService
): Promise<void> {
  const account = await serviceAccountService.getBillingAccountById(
    COGNI_SYSTEM_BILLING_ACCOUNT_ID
  );
  if (!account) {
    throw new Error(
      "FATAL: cogni_system billing account missing. Run migrations."
    );
  }
}
