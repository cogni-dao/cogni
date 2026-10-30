// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/finance/types`
 * Purpose: The operator's Financials page model: the shared snapshot projected to USD, plus the treasury id and the one summary.
 * Scope: View model only; no financial logic. The UI is the package component.
 * Invariants: The treasury is identified only from configuration, never inferred by the UI.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/task.5347
 * @public
 */
import type { MoneyPlaneSnapshot, ReportSummary } from "@cogni/money-plane";

export interface FinanceReportModel extends MoneyPlaneSnapshot {
  /** Plane id of the configured DAO treasury wallet, or null when none is declared. */
  treasuryPlane: string | null;
  summary: ReportSummary;
  /** Explorer page of the steward wallet, for the "result unknown" check after a withdrawal. */
  stewardWalletUrl: string | null;
}
