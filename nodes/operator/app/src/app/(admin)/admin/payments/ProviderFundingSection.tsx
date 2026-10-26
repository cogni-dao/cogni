// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/payments/ProviderFundingSection`
 * Purpose: The Provider funding rail (Fund steward, Top up OpenRouter, Top up Cherry) as one section below the Financials report.
 * Scope: Composition only; shared by the real page and the development preview so both render the same thing.
 * Invariants: The panel stays exactly as built; this adds only the divider and section title.
 * Side-effects: none
 * Links: ./AiFundingPanel.client.tsx, ./funding.server.ts, https://cognidao.org/knowledge/fund-cogni-vendors
 * @public
 */
import type { ReactElement } from "react";

import { ReportText, Separator } from "@/components";

import { AiFundingPanel } from "./AiFundingPanel.client";
import type { AiFunding } from "./funding.server";

export function ProviderFundingSection({
  funding,
}: {
  funding: AiFunding;
}): ReactElement {
  return (
    <>
      <Separator className="my-8" />
      <section className="space-y-4" aria-labelledby="provider-funding">
        <div className="space-y-1">
          <ReportText as="h2" id="provider-funding" variant="section">
            Provider funding
          </ReportText>
          <ReportText variant="caption" tone="muted">
            The money chain that keeps the node alive: user payments → operator
            wallet → steward wallet → vendors. The steward wallet pays both
            OpenRouter (inference) and Cherry (compute) in USDC — no card.
          </ReportText>
        </div>
        <AiFundingPanel funding={funding} />
      </section>
    </>
  );
}
