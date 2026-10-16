// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/nodes/[id]/payments/page`
 * Purpose: Compatibility entrypoint for old node-scoped payment activation links.
 * Scope: Owner-scoped DB read, then redirect to the canonical wizard shell.
 * Invariants: NODE_PAYMENT_ACTIVATION_STAYS_IN_WIZARD — activation is the Payments step at /nodes/[id].
 * Side-effects: IO (Postgres read)
 * Links: src/features/nodes/wizard/steps/PaymentActivationStep.client.tsx, task.5083
 * @public
 */

import { notFound, redirect } from "next/navigation";

import { readOwnedNode } from "@/app/_lib/owned-node-read";
import { getServerSessionUser } from "@/lib/auth/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function NodePaymentActivationPage({
  params,
}: PageProps): Promise<never> {
  const session = await getServerSessionUser();
  if (!session) {
    redirect("/");
  }

  const { id } = await params;
  const node = await readOwnedNode({
    id,
    userId: session.id,
    routeId: "nodes.payments",
  });
  if (!node) {
    notFound();
  }

  redirect(`/nodes/${node.id}`);
}
