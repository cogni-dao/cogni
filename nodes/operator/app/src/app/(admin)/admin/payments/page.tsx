// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/payments/page`
 * Purpose: Server entrypoint for the admin AI-funding pipeline. Reads the three balances
 *   (OpenRouter runway, operator wallet, steward wallet) and hands them to the client panel.
 * Scope: Server component. Access gating handled upstream by `(admin)/layout.tsx`.
 * Invariants: Read-only here; the only write is the panel's Fund-steward POST. Addresses from repo-spec.
 * Side-effects: IO (OpenRouter read + on-chain balance reads via getAiFunding).
 * Links: src/app/(admin)/admin/payments/{funding.server,AiFundingPanel.client}.tsx, docs/design/node-steward-wallet.md
 * @public
 */

import type { ReactElement } from "react";

import { PageContainer } from "@/components";

import { AiFundingPanel } from "./AiFundingPanel.client";
import { getAiFunding } from "./funding.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function ProviderTopUpsPage(): Promise<ReactElement> {
  const funding = await getAiFunding();

  return (
    <PageContainer maxWidth="2xl">
      <div className="space-y-1">
        <h1 className="font-bold text-2xl tracking-tight">
          OpenRouter Funding
        </h1>
        <p className="text-muted-foreground text-sm">
          The money chain that keeps AI alive: user payments → operator wallet →
          steward wallet → OpenRouter. Top up OpenRouter in USDC — no card.
        </p>
      </div>
      <AiFundingPanel funding={funding} />
    </PageContainer>
  );
}
