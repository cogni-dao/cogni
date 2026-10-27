// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/finance/credit-purchase-income.query`
 * Purpose: The operator's query for the package income reader: Σ and count of credited purchases, dated by the CREDITED event.
 * Scope: One aggregate SELECT through the injected Drizzle database (service role: payment tables are RLS-protected and
 *   income is a node-wide total). Drives from `payment_attempts` on its `(status, created_at)` index and joins
 *   one earliest actual CREDITED status transition per attempt. Duplicate transitions and later verification events
 *   cannot duplicate a purchase or move its credited date. Returns numbers only.
 * Invariants: Window measured on the credited time, never intent creation. Honours the reader's signal: aborted before
 *   the query ⇒ no query; aborted after ⇒ the result is discarded (the reader already reported UNKNOWN).
 * Side-effects: IO (one SELECT)
 * Links: packages/db-schema/src/billing.ts (payment_attempts, payment_events), src/features/payments/services/paymentService.ts
 * @public
 */
import type { CreditPurchaseTotals } from "@cogni/money-plane";
import { and, eq, gte, ne, sql } from "drizzle-orm";

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
    const credited = db
      .select({
        attemptId: paymentEvents.attemptId,
        creditedAt: sql<string>`min(${paymentEvents.createdAt})`.as(
          "credited_at"
        ),
      })
      .from(paymentEvents)
      .where(
        and(
          eq(paymentEvents.eventType, "STATUS_CHANGED"),
          eq(paymentEvents.toStatus, CREDITED_STATUS),
          ne(paymentEvents.fromStatus, CREDITED_STATUS)
        )
      )
      .groupBy(paymentEvents.attemptId)
      .as("credited");
    const rows = await db
      .select({
        totalUsdCents: sql<
          string | number
        >`coalesce(sum(${paymentAttempts.amountUsdCents}), 0)`,
        count: sql<string | number>`count(*)`,
      })
      .from(paymentAttempts)
      .innerJoin(credited, eq(credited.attemptId, paymentAttempts.id))
      .where(
        and(
          eq(paymentAttempts.status, CREDITED_STATUS),
          gte(credited.creditedAt, since.toISOString())
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
