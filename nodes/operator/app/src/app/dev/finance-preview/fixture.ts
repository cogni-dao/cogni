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
import type { MoneyPlaneRow, MoneyPlaneSnapshot } from "@cogni/money-plane";

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
export const financePreview: MoneyPlaneSnapshot = {
  takenAt: now,
  worst: "RED",
  rows: [
    {
      ...base,
      plane: "demo:treasury",
      label: "DAO treasury",
      kind: "wallet",
      balance: 75,
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
      balance: 12,
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
      balance: 8,
      currency: "USDC",
      grade: "INFO",
      source: "Demo · Base wallet read",
      sourceObservedAt: now,
      freshness: "current",
      payer: "Not established",
      beneficiary: "Human-custodied wallet",
      coverage: "unknown",
    },
    {
      ...base,
      plane: "demo:openrouter",
      label: "OpenRouter",
      balance: 120,
      currency: "USD",
      burnPerDay: 4,
      runwayDays: 30,
      grade: "GREEN",
      cumulativeVendorTransfer: { amount: "240", currency: "USD" },
      source: "Demo · Provider credits",
      sourceObservedAt: now,
      freshness: "current",
    },
    {
      ...base,
      plane: "demo:akash",
      label: "Akash hosting",
      kind: "prepaid",
      balance: 6,
      currency: "ACT",
      burnPerDay: 3,
      runwayDays: 2,
      grade: "RED",
      source: "Demo · Compute cost ledger",
      sourceObservedAt: now,
      freshness: "current",
      beneficiary: "node-template",
      nativeRate: { amount: "3000000", currency: "uact", per: "day" },
      cumulativeVendorTransfer: { amount: "1250000", currency: "uact" },
      detail: "Synthetic measured balance and burn",
    },
    {
      ...base,
      plane: "demo:cherry",
      label: "Cherry compute",
      balance: 36,
      currency: "EUR",
      burnPerDay: 4,
      runwayDays: 9,
      grade: "YELLOW",
      cumulativeVendorTransfer: { amount: "99", currency: "EUR" },
      source: "Demo · Compute balance",
      sourceObservedAt: now,
      freshness: "current",
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
