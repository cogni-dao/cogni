// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/payments/page`
 * Purpose: Financials — the read-only money-plane report above the existing Provider Funding rail.
 * Scope: Server component; access remains guarded by the existing admin layout.
 * Invariants: The report is read-only; the only write on this page stays the panel's Fund-steward POST.
 * Side-effects: Bounded provider reads through the shared finance service and getAiFunding.
 * Links: https://cognidao.org/work/items/task.5347, ./ProviderFundingSection.tsx, ./funding.server.ts
 * @public
 */
import type { ReactElement } from "react";

import { PageContainer } from "@/components";
import { FinanceReport } from "@/features/finance/components/FinanceReport";

import { getFinanceReport } from "./finance.server";
import { getAiFunding } from "./funding.server";
import { ProviderFundingSection } from "./ProviderFundingSection";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function FinancePage(): Promise<ReactElement> {
  const [report, funding] = await Promise.all([
    getFinanceReport(),
    getAiFunding(),
  ]);
  return (
    <PageContainer maxWidth="full">
      <FinanceReport report={report} />
      <ProviderFundingSection funding={funding} />
    </PageContainer>
  );
}
