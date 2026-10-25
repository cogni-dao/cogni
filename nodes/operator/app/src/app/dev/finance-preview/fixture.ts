// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/dev/finance-preview/fixture`
 * Purpose: Explicitly synthetic data for the development-only finance preview.
 * Scope: Static fixture; never imports a live reader.
 * Invariants: Not a statement of actual balances or costs.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/task.5347
 * @internal
 */
import type { CostRateEvidence, MoneyPlaneRow } from "@cogni/money-plane";

import type { FinanceReportModel } from "@/features/finance/types";

const now = "2026-10-25T01:40:00.000Z";
const base: MoneyPlaneRow = {
  plane: "demo",
  label: "Demo",
  kind: "prepaid",
  balance: null,
  currency: null,
  burnPerDay: null,
  runwayDays: null,
  grade: "UNKNOWN",
  observedAt: now,
  sourceObservedAt: null,
  freshness: "unknown",
  payer: "Operator DAO",
  beneficiary: "Fleet",
  coverage: "operator-covered",
};
export const financePreview: FinanceReportModel = {
  takenAt: now,
  treasuryPlane: "demo:treasury",
  costRateEvidence: [
    ...[2, 3].map(
      (amount, index): CostRateEvidence => ({
        sourceId: `demo:akash:${index}`,
        ownerId: "operator",
        scopeId: "operator-fleet",
        instrumentId: "akash:uact",
        basis: { kind: "contract", active: true },
        rate: { amount: String(amount), currency: "uact", per: "block" },
        sourceObservedAt: null,
        partial: true,
      })
    ),
    ...[2, 3].map(
      (amount, index): CostRateEvidence => ({
        sourceId: `demo:measured:${index}`,
        ownerId: "example",
        scopeId: "synthetic example",
        instrumentId: "example:usd",
        basis: {
          kind: "measured",
          start: "2026-10-24T00:00:00Z",
          end: "2026-10-25T00:00:00Z",
        },
        rate: { amount: String(amount), currency: "USD", per: "day" },
        sourceObservedAt: now,
        partial: false,
      })
    ),
  ],
  worst: "RED",
  rows: [
    {
      ...base,
      plane: "demo:treasury",
      label: "DAO treasury",
      kind: "wallet",
      balance: 10,
      currency: "USDC",
      grade: "INFO",
      source: "Demo · Base wallet read",
      sourceObservedAt: now,
      freshness: "current",
      beneficiary: "DAO treasury",
      coverage: "direct",
    },
    {
      ...base,
      plane: "demo:float",
      label: "Operator working capital",
      kind: "wallet",
      balance: 20,
      currency: "USDC",
      grade: "INFO",
      source: "Demo · Base wallet read",
      sourceObservedAt: now,
      freshness: "current",
      beneficiary: "Operator",
      coverage: "direct",
    },
    {
      ...base,
      plane: "demo:steward",
      label: "Steward custody",
      kind: "wallet",
      balance: 30,
      currency: "USDC",
      grade: "INFO",
      source: "Demo · Base wallet read",
      sourceObservedAt: now,
      freshness: "current",
      payer: "Not established",
      beneficiary: "Human-custodied wallet",
      coverage: "unknown",
    },
    ...[2, 3].map(
      (amount, index): MoneyPlaneRow => ({
        ...base,
        plane: `demo:measured:${index}`,
        label: index === 0 ? "Example service A" : "Example service B",
        balance: index === 0 ? 10 : 90,
        currency: "USD",
        burnPerDay: amount,
        runwayDays: index === 0 ? 5 : 30,
        grade: index === 0 ? "RED" : "GREEN",
        source: "Demo · Synthetic measured interval",
        sourceObservedAt: now,
        freshness: "current",
        beneficiary: "Synthetic example",
        detail: "Synthetic test case; not live provider coverage",
      })
    ),
    ...[2, 3].map(
      (amount, index): MoneyPlaneRow => ({
        ...base,
        plane: `demo:akash:${index}`,
        label: "Akash hosting",
        kind: "usage",
        source: "Demo · Stored active contract aggregate",
        beneficiary: index === 0 ? "node-template" : "cherry-node",
        nativeRate: { amount: String(amount), currency: "uact", per: "block" },
        ...(index === 0
          ? {
              cumulativeVendorTransfer: { amount: "1250000", currency: "uact" },
            }
          : {}),
        detail: "Source observation time unavailable",
      })
    ),
    {
      ...base,
      plane: "demo:openrouter",
      label: "OpenRouter",
      detail: "Balance unavailable; scoped read-only provider access pending",
    },
    {
      ...base,
      plane: "demo:cherry",
      label: "Cherry compute",
      detail: "Balance unavailable; scoped read-only provider access pending",
    },
    {
      ...base,
      plane: "demo:grafana",
      label: "Grafana",
      kind: "usage",
      source: "Not connected",
      detail: "Usage cost not available",
    },
    {
      ...base,
      plane: "demo:github",
      label: "GitHub",
      kind: "fixed",
      source: "Not connected",
      detail: "Subscription amount not available",
    },
  ],
};
