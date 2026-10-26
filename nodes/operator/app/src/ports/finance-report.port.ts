// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@ports/finance-report.port`
 * Purpose: Operator-local extension of the shared money-plane row: named exact parts of a balance for the Source dialog.
 * Scope: Types only. The shared package row model is unchanged; parts are display evidence, never summed by the UI.
 * Invariants: Exact source-native text; no conversion inside the type.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/task.5347
 * @public
 */
import type { MoneyPlaneRow } from "@cogni/money-plane";

/** One named component of a balance, in exact native units (e.g. Console credit and escrow in uact). */
export interface FinanceRowPart {
  readonly label: string;
  readonly amount: string;
  readonly currency: string;
}

export interface FinanceRow extends MoneyPlaneRow {
  readonly parts?: readonly FinanceRowPart[];
  /** True when this row's burn is the sum of other rows' burn (e.g. a credit pool over hosting lines); excluded from fleet totals. */
  readonly rollup?: boolean;
}
