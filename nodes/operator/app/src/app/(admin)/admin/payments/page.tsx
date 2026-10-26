// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/payments/page`
 * Purpose: Financials — the read-only money-plane report above the existing Provider Funding rail.
 * Scope: Server component; access remains guarded by the existing admin layout.
 * Invariants: The report is read-only; the only write on this page stays the panel's Fund-steward POST.
 * Side-effects: Bounded provider reads through the shared finance service and getAiFunding.
 * Links: https://cognidao.org/work/items/task.5347, ./AiFundingPanel.client.tsx, ./funding.server.ts
 * @public
 */
import type { ReactElement } from "react";

import { PageContainer, ReportText, Separator } from "@/components";
import { FinanceReport } from "@/features/finance/components/FinanceReport";

import { AiFundingPanel } from "./AiFundingPanel.client";
import { getFinanceReport } from "./finance.server";
import { getAiFunding } from "./funding.server";

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
      <Separator className="my-8" />
      <section className="space-y-4" aria-labelledby="provider-funding">
        <div className="space-y-1">
          <ReportText as="h2" id="provider-funding" variant="section">
            Provider Funding
          </ReportText>
          <ReportText variant="caption" tone="muted">
            The money chain that keeps the node alive: user payments → operator
            wallet → steward wallet → vendors. The steward wallet pays both
            OpenRouter (inference) and Cherry (compute) in USDC — no card.
          </ReportText>
        </div>
        <AiFundingPanel funding={funding} />
      </section>
    </PageContainer>
  );
}
