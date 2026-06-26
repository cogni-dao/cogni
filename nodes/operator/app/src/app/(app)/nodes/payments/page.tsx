// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/nodes/payments/page`
 * Purpose: Compatibility redirect for old payment activation links.
 * Scope: Redirect only. Node payment activation is owned by `/nodes/[id]/payments`.
 * Invariants: NO_OPERATOR_PAYMENT_FALLBACK — a missing node id does not activate operator repo-spec.
 * Side-effects: redirect
 * Links: src/app/(app)/nodes/[id]/payments/page.tsx, task.5083
 * @public
 */

import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PageProps {
  searchParams: Promise<{ nodeId?: string }>;
}

export default async function PaymentActivationPage({
  searchParams,
}: PageProps): Promise<never> {
  const sp = await searchParams;
  const nodeId = sp.nodeId ?? null;

  if (nodeId) {
    redirect(`/nodes/${encodeURIComponent(nodeId)}/payments`);
  }

  redirect("/nodes");
}
