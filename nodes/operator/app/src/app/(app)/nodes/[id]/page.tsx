// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/nodes/[id]/page`
 * Purpose: Single registered node — server fetch + the always-mounted wizard shell.
 * Scope: Owner-scoped DB read; projects the row + external URLs into the client `NodeWizard`.
 *   The wizard frame owns identity + progress; no separate header/technical chrome.
 * Links: src/features/nodes/wizard/NodeWizard.client.tsx, task.5083
 * @public
 */

import { withTenantScope } from "@cogni/db-client";
import { type UserId, userActor } from "@cogni/ids";
import { getDaoUrl } from "@cogni/node-shared";
import { and, eq } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactElement } from "react";
import { resolveAppDb } from "@/bootstrap/container";
import { PageContainer } from "@/components";
import { nodeRepoUrlForSlug } from "@/features/nodes/launch-pack";
import { NodeWizard } from "@/features/nodes/wizard/NodeWizard.client";
import { getServerSessionUser } from "@/lib/auth/server";
import { type NodeStatus, nodes } from "@/shared/db/nodes";
import { serverEnv } from "@/shared/env";
import {
  buildNodeKnowledgeRemote,
  knowledgeRemoteWebUrl,
} from "@/shared/node-app-scaffold/knowledge-remote";

import { NODE_STATUS_DISPLAY } from "../node-display";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
  const display = NODE_STATUS_DISPLAY[status];
  const env = serverEnv();
  const nodeRepoUrl = nodeRepoUrlForSlug({
    slug: node.slug,
    mintOwner: env.NODE_MINT_OWNER,
    publishPrUrl: node.publishPrUrl,
  });
  const knowledgeRemote = env.DOLTHUB_OWNER
    ? buildNodeKnowledgeRemote(node.slug, env.DOLTHUB_OWNER)
    : null;
  const knowledgeRepoUrl = knowledgeRemote
    ? knowledgeRemoteWebUrl(knowledgeRemote)
    : null;
  const daoUrl =
    node.daoAddress && node.chainId
      ? getDaoUrl(node.chainId, node.daoAddress)
      : null;

  return (
    <PageContainer maxWidth="3xl">
      <Link
        href="/nodes"
        className="inline-flex items-center gap-1.5 text-muted-foreground text-sm hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Nodes
      </Link>

      <NodeWizard
        statusLabel={display.label}
        node={{
          id: node.id,
          slug: node.slug,
          status,
          daoAddress: node.daoAddress,
          chainId: node.chainId,
          operatorWalletAddress: node.operatorWalletAddress,
          splitAddress: node.splitAddress,
          publishPrUrl: node.publishPrUrl,
          failureReason: node.failureReason,
          nodeRepoUrl,
          knowledgeRepoUrl,
          daoUrl,
        }}
      />
    </PageContainer>
  );
}
