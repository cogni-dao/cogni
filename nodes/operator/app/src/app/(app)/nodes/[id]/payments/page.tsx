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

import { withTenantScope } from "@cogni/db-client";
import { type UserId, userActor } from "@cogni/ids";
import { and, eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";

import { resolveAppDb } from "@/bootstrap/container";
import { getServerSessionUser } from "@/lib/auth/server";
import { nodes } from "@/shared/db/nodes";

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
  const db = resolveAppDb();
  const rows = await withTenantScope(
    db,
    userActor(session.id as UserId),
    async (tx) =>
      tx
        .select()
        .from(nodes)
        .where(and(eq(nodes.id, id), eq(nodes.ownerUserId, session.id)))
        .limit(1)
  );

  const node = rows[0];
  if (!node) {
    notFound();
  }

  redirect(`/nodes/${node.id}`);
}
