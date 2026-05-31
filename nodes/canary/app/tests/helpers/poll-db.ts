// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/helpers/poll-db`
 * Purpose: Polling helper for async billing receipts in stack tests.
 * Scope: Waits for rows to appear in the DB after LiteLLM callback fires asynchronously. Does not handle retry logic or persistent failures.
 * Invariants: CALLBACK_IS_SOLE_WRITER — receipts arrive via async LiteLLM callback, not in-process
 * Side-effects: IO (database reads)
 * Links: tests/stack/ai/*.stack.test.ts
 * @internal
 */

import type { Database } from "@cogni/db-client";
import { eq } from "drizzle-orm";
import { chargeReceipts } from "@/shared/db/schema";

/**
 * Poll the DB for charge_receipts to appear for a given billing account.
 *
 * Per CALLBACK_IS_SOLE_WRITER: receipts are written asynchronously by the
 * LiteLLM callback (POST /api/internal/billing/ingest). After an in-process
 * graph run completes, there is a brief delay before the callback fires and
 * the receipt row appears in the DB.
 *
 * @param db - Service-role database client
 * @param billingAccountId - Billing account to query
 * @param opts.minCount - Minimum number of receipts expected (default: 1)
 * @param opts.timeoutMs - Max wait time (default: 10_000ms)
 * @param opts.intervalMs - Poll interval (default: 250ms)
 * @returns Array of charge_receipt rows
 * @throws Error if timeout reached before minCount receipts appear
 */
export async function waitForReceipts(
  db: Database,
  billingAccountId: string,
  opts?: { minCount?: number; timeoutMs?: number; intervalMs?: number }
): Promise<(typeof chargeReceipts.$inferSelect)[]> {
  const minCount = opts?.minCount ?? 1;
  const timeoutMs = opts?.timeoutMs ?? 10_000;
  const intervalMs = opts?.intervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const rows = await db
      .select()
      .from(chargeReceipts)
      .where(eq(chargeReceipts.billingAccountId, billingAccountId));

    if (rows.length >= minCount) return rows;

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  // Final attempt
  const rows = await db
    .select()
    .from(chargeReceipts)
    .where(eq(chargeReceipts.billingAccountId, billingAccountId));

  if (rows.length >= minCount) return rows;

  throw new Error(
    `waitForReceipts: timed out after ${timeoutMs}ms — expected ≥${minCount} receipts for billing account ${billingAccountId}, found ${rows.length}. ` +
      `This likely means the LiteLLM callback (POST /api/internal/billing/ingest) did not fire. ` +
      `Check LiteLLM container logs and COGNI_NODE_ENDPOINTS env var.`
  );
}
