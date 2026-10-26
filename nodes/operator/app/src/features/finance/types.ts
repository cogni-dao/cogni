// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/finance/types`
 * Purpose: Operator-owned reporting context beside the shared reader snapshot.
 * Scope: View model only; no financial eligibility logic.
 * Invariants: The treasury is identified only from configuration, never inferred by the UI.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/task.5347
 * @public
 */
import type { MoneyPlaneSnapshot } from "@cogni/money-plane";

import type { FinanceRow } from "@/ports/finance-report.port";

export type { FinanceRow, FinanceRowPart } from "@/ports/finance-report.port";

export interface FinanceReportModel extends Omit<MoneyPlaneSnapshot, "rows"> {
  rows: FinanceRow[];
  /** Plane id of the configured DAO treasury wallet, or null when none is declared. */
  treasuryPlane: string | null;
}
