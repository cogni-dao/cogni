// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/finance/credit-purchase-income.query`
 * Purpose: The operator's query for the package income reader: Σ and count of credited purchases, dated by the CREDITED event.
 * Scope: One aggregate SELECT through the injected Drizzle database (service role: payment tables are RLS-protected and
 *   income is a node-wide total). Drives from `payment_attempts` on its `(status, created_at)` index and joins
 *   `payment_events` only to take the CREDITED timestamp (exactly one per attempt: CREDITED is terminal). Returns numbers only.
 * Invariants: Window measured on the credited time, never intent creation. Honours the reader's signal: aborted before
 *   the query ⇒ no query; aborted after ⇒ the result is discarded (the reader already reported UNKNOWN).
 * Side-effects: IO (one SELECT)
 * Links: packages/db-schema/src/billing.ts (payment_attempts, payment_events), src/features/payments/services/paymentService.ts
 * @public
 */
import type { CreditPurchaseTotals } from "@cogni/money-plane";
import { and, eq, gte, sql } from "drizzle-orm";

import type { Database } from "@/adapters/server/db/client";
import { paymentAttempts, paymentEvents } from "@/shared/db";

/** The terminal success status written by the payment service after on-chain verification. */
export const CREDITED_STATUS = "CREDITED";

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("income query aborted");
}

export function creditedPurchasesQuery(db: Database) {
  return async (
    since: Date,
    signal: AbortSignal
  ): Promise<CreditPurchaseTotals> => {
    throwIfAborted(signal);
    const rows = await db
      .select({
        totalUsdCents: sql<
          string | number
        >`coalesce(sum(${paymentAttempts.amountUsdCents}), 0)`,
        count: sql<string | number>`count(*)`,
      })
      .from(paymentAttempts)
      .innerJoin(
        paymentEvents,
        and(
          eq(paymentEvents.attemptId, paymentAttempts.id),
          eq(paymentEvents.toStatus, CREDITED_STATUS)
        )
      )
      .where(
        and(
          eq(paymentAttempts.status, CREDITED_STATUS),
          gte(paymentEvents.createdAt, since)
        )
      );
    throwIfAborted(signal);
    const first = rows[0];
    return {
      totalUsdCents: Number(first?.totalUsdCents ?? 0),
      count: Number(first?.count ?? 0),
    };
  };
}
