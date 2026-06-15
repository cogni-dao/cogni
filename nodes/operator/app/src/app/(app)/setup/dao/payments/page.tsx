// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/setup/dao/payments/page`
 * Purpose: Legacy payment activation URL. Redirects to the canonical nodes payment route.
 * Scope: Server redirect only.
 * Side-effects: redirect
 * Links: src/app/(app)/nodes/payments/page.tsx
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
  const suffix = nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : "";
  redirect(`/nodes/payments${suffix}`);
}
