// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/graph-execution-host/ports/billing-identity`
 * Purpose: Per-run billing identity interface attached to usage_report events.
 * Scope: Defines BillingIdentity shape for billing enrichment. Does not contain billing logic or database access.
 * Invariants: PURE_LIBRARY — no env vars, no process lifecycle.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/package-isolation-rules, src/decorators/billing-enrichment.decorator.ts
 * @public
 */
export interface BillingIdentity {
  readonly billingAccountId: string;
  readonly virtualKeyId: string;
}
