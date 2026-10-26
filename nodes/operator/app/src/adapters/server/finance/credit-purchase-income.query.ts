// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/finance/credit-purchase-income.query`
 * Purpose: The operator's query for the package income reader: purchases by the time they were CREDITED.
 * Scope: One read through the injected Drizzle database (service role: payment tables are RLS-protected and income is a
 *   node-wide total). The window is measured on `payment_events.created_at` of the CREDITED transition, never on intent
 *   creation. Returns only amount and time; never addresses or tx hashes.
 * Invariants: Only attempts currently `CREDITED` count, dated by their CREDITED event.
 * Side-effects: IO (one SELECT)
 * Links: packages/db-schema/src/billing.ts (payment_attempts, payment_events), src/features/payments/services/paymentService.ts
 * @public
 */
import { and, eq, gte } from "drizzle-orm";

import type { Database } from "@/adapters/server/db/client";
import { paymentAttempts, paymentEvents } from "@/shared/db";

/** The terminal success status written by the payment service after on-chain verification. */
export const CREDITED_STATUS = "CREDITED";

export function creditedPurchasesQuery(db: Database) {
  return async (since: Date) =>
    db
      .select({
        amountUsdCents: paymentAttempts.amountUsdCents,
        createdAt: paymentEvents.createdAt,
      })
      .from(paymentEvents)
      .innerJoin(
        paymentAttempts,
        eq(paymentEvents.attemptId, paymentAttempts.id)
      )
      .where(
        and(
          eq(paymentEvents.toStatus, CREDITED_STATUS),
          eq(paymentAttempts.status, CREDITED_STATUS),
          gte(paymentEvents.createdAt, since)
        )
      );
}
