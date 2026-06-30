// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(public)/claim/[epoch]/page`
 * Purpose: Public page for contributors to claim their DAO tokens for a finalized epoch.
 * Scope: Server component wrapper — resolves the epoch route param and renders the client claim flow. No auth required.
 * Invariants: Public read; claim proof fetched client-side from the public distribution route for the connected wallet.
 * Side-effects: none (server component)
 * Links: nodes/operator/app/src/app/api/v1/public/attribution/epochs/[id]/distribution/route.ts
 * @public
 */

import { Suspense } from "react";

import { PageContainer } from "@/components/kit/layout/PageContainer";

import { ClaimTokens } from "./claim-tokens.client";

export default async function ClaimPage({
  params,
}: {
  params: Promise<{ epoch: string }>;
}) {
  const { epoch } = await params;

  return (
    <PageContainer maxWidth="2xl">
      <Suspense>
        <ClaimTokens epoch={epoch} />
      </Suspense>
    </PageContainer>
  );
}
