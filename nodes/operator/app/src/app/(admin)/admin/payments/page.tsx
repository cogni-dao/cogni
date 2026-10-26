// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/payments/page`
 * Purpose: Financials — one table of the node's money planes with balances, burn, runway and row actions.
 * Scope: Server component; access remains guarded by the existing admin layout. finance.server is the only read path.
 * Invariants: ONE_ROW_MODEL — every action is a row `payAction`; the only write stays the fund-steward POST.
 * Side-effects: Bounded provider reads through the shared finance service.
 * Links: https://cognidao.org/work/items/task.5347, ./finance.server.ts
 * @public
 */
import type { ReactElement } from "react";

import { PageContainer } from "@/components";
import { FinanceReport } from "@/features/finance/components/FinanceReport";

import { getFinanceReport } from "./finance.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function FinancePage(): Promise<ReactElement> {
  const report = await getFinanceReport();
  return (
    <PageContainer maxWidth="full">
      <FinanceReport report={report} />
    </PageContainer>
  );
}
