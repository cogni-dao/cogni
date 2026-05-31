// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/_fakes/accounts/billing-builders`
 * Purpose: Test data factories for charge receipts and billing entities.
 * Scope: Creates minimal charge_receipt test data per ACTIVITY_METRICS.md. Does not include forbidden fields.
 * Invariants: No model/tokens/usage fields - LiteLLM is canonical for telemetry
 * Side-effects: none
 * Links: docs/spec/activity-metrics.md, src/shared/db/schema.billing.ts
 * @public
 */

import { randomUUID } from "node:crypto";

import type { ChargeReceiptProvenance } from "@/ports";

/**
 * Shape of a charge receipt row for test insertion.
 * Matches chargeReceipts schema exactly - no forbidden fields.
 */
export interface TestChargeReceipt {
  id: ReturnType<typeof randomUUID>;
  billingAccountId: string;
  virtualKeyId: string;
  requestId: string;
  litellmCallId: string | null;
  chargedCredits: bigint;
  responseCostUsd: string | null;
  provenance: ChargeReceiptProvenance;
  createdAt: Date;
}

/**
 * Creates a test charge receipt with sensible defaults.
 * All forbidden fields (model, tokens, usage) are intentionally absent.
 */
export function makeTestChargeReceipt(
  overrides: Partial<TestChargeReceipt> & {
    billingAccountId: string;
    virtualKeyId: string;
  }
): TestChargeReceipt {
  return {
    id: randomUUID(),
    requestId: randomUUID(),
    litellmCallId: `call-${randomUUID()}`,
    chargedCredits: 1000n,
    responseCostUsd: "0.001000",
    provenance: "response",
    createdAt: new Date(),
    ...overrides,
  };
}
