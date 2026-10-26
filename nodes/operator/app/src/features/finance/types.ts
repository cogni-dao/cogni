// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/finance/types`
 * Purpose: Operator-owned reporting context beside the shared reader snapshot.
 * Scope: View model only; no financial eligibility logic.
 * Invariants: Explicit treasury identity and cost attribution are never inferred by the UI.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/task.5347
 * @public
 */
import type { CostRateEvidence, MoneyPlaneSnapshot } from "@cogni/money-plane";
export interface FinanceReportModel extends MoneyPlaneSnapshot {
  treasuryPlane: string | null;
  configuredWalletPlanes: string[];
  costRateEvidence: CostRateEvidence[];
}
