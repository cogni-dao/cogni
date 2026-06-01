// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(public)/propose/merge/page`
 * Purpose: Public page for creating DAO merge proposals via wallet signing.
 * Scope: Server component wrapper — renders client component. No auth required.
 * Invariants: URL params validated client-side; contract addresses from URL (matching standalone MVP).
 * Side-effects: none (server component)
 * Links: cogni-proposal-launcher, src/features/governance/lib/proposal-utils.ts
 * @public
 */

import { Suspense } from "react";

import { PageContainer } from "@/components/kit/layout/PageContainer";

import { MergeProposal } from "./merge-proposal.client";

export default function MergeProposalPage() {
  return (
    <PageContainer maxWidth="2xl">
      <Suspense>
        <MergeProposal />
      </Suspense>
    </PageContainer>
  );
}
