// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(public)/claim/[epoch]/page`
 * Purpose: Legacy per-epoch claim URL — redirects to the cumulative claim on /gov/holdings.
 * Scope: Server component. The token model is CUMULATIVE: a single claim against the latest
 *        merkle root pays out ALL unclaimed epochs, so per-epoch claiming no longer exists.
 *        This route is kept only to preserve old links; it forwards to the holdings claim panel.
 * Invariants:
 *   - CUMULATIVE_MODEL: there is no per-epoch claim; one cumulative claim covers every unclaimed epoch.
 *   - NO_BROKEN_CLAIM: never render a stale stock-MerkleDistributor per-epoch flow.
 * Side-effects: HTTP redirect.
 * Links: nodes/operator/app/src/app/(app)/gov/holdings/view.tsx, nodes/operator/app/src/features/governance/components/CumulativeClaimPanel.tsx
 * @public
 */

import { redirect } from "next/navigation";

export default async function ClaimPage({
  params,
}: {
  params: Promise<{ epoch: string }>;
}) {
  // Resolve the param so Next doesn't warn, then forward to the cumulative claim.
  await params;
  redirect("/gov/holdings");
}
