// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/setup/nodes/[id]/page`
 * Purpose: Dashboard for a single registered node — renders state + the appropriate action button.
 * Scope: Server fetch; client island for the action button so the user can click without page flicker.
 * Links: task.5083
 * @public
 */

import { withTenantScope } from "@cogni/db-client";
import { type UserId, userActor } from "@cogni/ids";
import { and, eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import type { ReactElement } from "react";
import { resolveAppDb } from "@/bootstrap/container";
import { PageContainer, SectionCard } from "@/components";
import { getServerSessionUser } from "@/lib/auth/server";
import { type NodeStatus, nodes } from "@/shared/db/nodes";

import { NodeActionPanel } from "./NodeActionPanel.client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATUS_DESCRIPTION: Record<NodeStatus, string> = {
  dao_pending: "Step 1 of 5 — form the DAO via the wallet-signed wizard.",
  dao_formed:
    "Step 2 of 5 — operator will provision the Privy wallet on your behalf.",
  wallet_ready: "Step 3 of 5 — sign the Split deploy via the payments wizard.",
  payments_ready:
    "Step 4 of 5 — operator will open the repo-spec PR on your repo.",
  active: "Step 5 of 5 — repo-spec PR opened; merge it to complete bootstrap.",
  failed: "This bootstrap run failed. Re-register the node to start over.",
};

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function NodeDashboardPage({
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

  const status = node.status as NodeStatus;

  return (
    <PageContainer>
      <SectionCard title={node.repoUrl}>
        <p className="mb-3 text-muted-foreground text-sm">
          {STATUS_DESCRIPTION[status]}
        </p>
        <div className="space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-2">
            <span className="text-muted-foreground">Status</span>
            <span className="font-mono uppercase">{node.status}</span>
            <span className="text-muted-foreground">Chain</span>
            <span className="font-mono">{node.chainId ?? "—"}</span>
            <span className="text-muted-foreground">DAO</span>
            <span className="break-all font-mono">
              {node.daoAddress ?? "—"}
            </span>
            <span className="text-muted-foreground">Operator wallet</span>
            <span className="break-all font-mono">
              {node.operatorWalletAddress ?? "—"}
            </span>
            <span className="text-muted-foreground">Payment Split</span>
            <span className="break-all font-mono">
              {node.splitAddress ?? "—"}
            </span>
            {node.publishPrUrl ? (
              <>
                <span className="text-muted-foreground">repo-spec PR</span>
                <a
                  className="break-all font-mono text-blue-500 underline"
                  href={node.publishPrUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {node.publishPrUrl}
                </a>
              </>
            ) : null}
            {node.failureReason ? (
              <>
                <span className="text-muted-foreground">Failure reason</span>
                <span className="text-red-500">{node.failureReason}</span>
              </>
            ) : null}
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Next step">
        <NodeActionPanel nodeId={node.id} status={status} />
      </SectionCard>
    </PageContainer>
  );
}
