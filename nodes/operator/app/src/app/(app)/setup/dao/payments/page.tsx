// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/setup/dao/payments/page`
 * Purpose: Legacy payment activation URL. Redirects old node-scoped links into the node route.
 * Scope: Server redirect only.
 * Side-effects: redirect
 * Links: src/app/(app)/nodes/[id]/payments/page.tsx
 * @public
 */

import { redirect } from "next/navigation";

interface PageProps {
  searchParams: Promise<{ nodeId?: string }>;
}

export default async function LegacyPaymentActivationPage({
  searchParams,
}: PageProps): Promise<never> {
  const { nodeId } = await searchParams;
  if (nodeId) {
    redirect(`/nodes/${encodeURIComponent(nodeId)}/payments`);
  }
  redirect("/nodes");
}
