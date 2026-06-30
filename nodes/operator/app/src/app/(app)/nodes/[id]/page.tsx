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

import type { NodeDeployState } from "@cogni/ai-tools";
import { withTenantScope } from "@cogni/db-client";
import { type UserId, userActor } from "@cogni/ids";
import { getDaoUrl } from "@cogni/node-shared";
import { and, eq } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactElement } from "react";
import { createNodeRepoWriter } from "@/bootstrap/capabilities/node-repo-write";
import {
  getContainer,
  resolveAppDb,
  resolveServiceDb,
} from "@/bootstrap/container";
import { PageContainer } from "@/components";
import { NodeAccess } from "@/features/nodes/access/NodeAccess";
import { listAccessRequests } from "@/features/nodes/access-requests";
import { DistributionsCard } from "@/features/nodes/DistributionsCard.client";
import { NodeDeployments } from "@/features/nodes/deployments/NodeDeployments";
import { FLIGHT_ENVS } from "@/features/nodes/flight-status";
import { nodeRepoUrlForSlug } from "@/features/nodes/launch-pack";
import { ResetDaoDangerZone } from "@/features/nodes/ResetDaoDangerZone.client";
import { NodeWizard } from "@/features/nodes/wizard/NodeWizard.client";
import type { WizardNode } from "@/features/nodes/wizard/types";
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
  const repoSpecUrl = nodeRepoUrl
    ? `${nodeRepoUrl.replace(/\/$/, "")}/blob/main/.cogni/repo-spec.yaml`
    : null;
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

  // Owner-only developer/deploy dashboard, mounted once the node is handed off to an AI dev.
  // Wallet/payments statuses are still handoff/dashboard states; payments activation is an action,
  // not a replacement for the RBAC approval and environment visibility surface.
  const showDevelopers = [
    "published",
    "wallet_ready",
    "payments_ready",
    "active",
  ].includes(status);
  const accessRequests = showDevelopers
    ? await listAccessRequests(resolveServiceDb(), node.id)
    : [];

  // SEE flow: read which envs this node is live in. Probe-backed (public surface), so only fetch once
  // the node is published — earlier statuses serve nowhere. Degrade to null if the capability is
  // unwired (no base domain) so the page never breaks.
  const deployCapability = getContainer().deployCapability;
  const deployEnvs: NodeDeployState[] | null =
    showDevelopers && deployCapability
      ? await Promise.all(
          FLIGHT_ENVS.map((deployEnv) =>
            deployCapability.getDeployState({
              env: deployEnv,
              node: node.slug,
            })
          )
        )
      : null;
  let paymentActivation: WizardNode["paymentActivation"] = null;
  if (node.operatorWalletAddress && node.splitAddress && env.NODE_MINT_OWNER) {
    try {
      const status = await createNodeRepoWriter(
        env
      ).getPaymentsActivationStatus({
        owner: env.NODE_MINT_OWNER,
        repo: node.slug,
        slug: node.slug,
        nodeWalletAddress: node.operatorWalletAddress,
        splitAddress: node.splitAddress,
      });
      const production = deployEnvs?.find(
        (deployEnv) => deployEnv.env === "production"
      );
      const productionMatchesSource =
        status.repoSpecActive &&
        status.mainSha !== null &&
        production?.buildSha === status.mainSha;
      paymentActivation = {
        repoSpecActive: status.repoSpecActive,
        sourceSha: status.mainSha,
        activationPrUrl: status.activationPr?.url ?? null,
        activationPrState: status.activationPr?.state ?? null,
        productionBuildSha: production?.buildSha ?? null,
        productionMatchesSource,
      };
    } catch {
      // Best-effort activation projection: a GitHub/App hiccup must not break the dashboard.
      paymentActivation = null;
    }
  }
  const statusLabel =
    paymentActivation?.productionMatchesSource === true
      ? NODE_STATUS_DISPLAY.active.label
      : node.splitAddress && status !== "active"
        ? "Activating payments"
        : display.label;

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
        statusLabel={statusLabel}
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
          repoSpecUrl,
          paymentActivation,
        }}
      />

      {deployEnvs ? <NodeDeployments envs={deployEnvs} /> : null}

      {showDevelopers ? (
        <NodeAccess nodeId={node.id} requests={accessRequests} />
      ) : null}

      {/* Visible, owner-driven distribution activation — NOT a hidden API. The page query already
          scopes to the owner, so reaching this page IS the owner gate. Surface it only when there
          is a DAO and the node is far enough along to activate (mirrors the route's status gate). */}
      {node.daoAddress != null && showDevelopers ? (
        <DistributionsCard
          nodeId={node.id}
          slug={node.slug}
          repoSpecUrl={repoSpecUrl}
        />
      ) : null}

      {/* Owner-only destructive control. The page query already scopes to the owner
          (eq(nodes.ownerUserId, session.id)), so reaching this page IS the owner gate.
          Only surface it when there is actually a DAO to reset (mirrors the route's 409). */}
      {node.daoAddress != null || status !== "dao_pending" ? (
        <ResetDaoDangerZone nodeId={node.id} slug={node.slug} />
      ) : null}
    </PageContainer>
  );
}
