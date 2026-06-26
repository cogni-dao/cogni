// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/nodes/[id]/payments/page`
 * Purpose: Node-scoped payment activation entrypoint. Loads the owner-scoped node row and passes
 *   its operator wallet + DAO addresses into the Split deployment client.
 * Scope: DB read + render only. The client component owns wallet signing and node PATCH on success.
 * Invariants: NODE_PAYMENT_ACTIVATION_IS_NODE_SCOPED — no repo-spec fallback or operator activation.
 * Side-effects: IO (Postgres read)
 * Links: src/features/nodes/wizard/steps/SimpleSteps.tsx, task.5083
 * @public
 */

import { withTenantScope } from "@cogni/db-client";
import { type UserId, userActor } from "@cogni/ids";
import { and, eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import type { ReactElement } from "react";

import { resolveAppDb } from "@/bootstrap/container";
import { getServerSessionUser } from "@/lib/auth/server";
import { nodes } from "@/shared/db/nodes";

import { PaymentActivationPageClient } from "../../payments/PaymentActivationPage.client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function NodePaymentActivationPage({
  params,
}: PageProps): Promise<ReactElement> {
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

  return (
    <PaymentActivationPageClient
      operatorWalletAddress={node.operatorWalletAddress ?? null}
      daoTreasuryAddress={node.daoAddress ?? null}
      nodeId={node.id}
    />
  );
}
