// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/finance/credit-purchase-income.query`
 * Purpose: The operator's query for the package income reader: credited payment_attempts since a date.
 * Scope: One read through the injected Drizzle database (service role: payment_attempts is RLS-protected and this is a
 *   node-wide total, not a tenant view). Returns only amount and time; never addresses or tx hashes.
 * Invariants: Only `CREDITED` attempts count (the terminal success status the payment service writes).
 * Side-effects: IO (one SELECT)
 * Links: packages/db-schema/src/billing.ts, src/features/payments/services/paymentService.ts
 * @public
 */
import { and, eq, gte } from "drizzle-orm";

import type { Database } from "@/adapters/server/db/client";
import { paymentAttempts } from "@/shared/db";

/** The terminal success status written by the payment service after on-chain verification. */
export const CREDITED_STATUS = "CREDITED";

export function creditedPurchasesQuery(db: Database) {
  return async (since: Date) =>
    db
      .select({
        amountUsdCents: paymentAttempts.amountUsdCents,
        createdAt: paymentAttempts.createdAt,
      })
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.status, CREDITED_STATUS),
          gte(paymentAttempts.createdAt, since)
        )
      );
}
