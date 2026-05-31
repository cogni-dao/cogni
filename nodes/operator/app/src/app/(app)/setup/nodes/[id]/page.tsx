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
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Fragment, type ReactElement } from "react";
import { resolveAppDb } from "@/bootstrap/container";
import { PageContainer, SectionCard } from "@/components";
import { getServerSessionUser } from "@/lib/auth/server";
import { type NodeStatus, nodes } from "@/shared/db/nodes";

import { NODE_STATUS_DISPLAY } from "../node-display";
import { NodeActionPanel } from "./NodeActionPanel.client";
import { NodeDaoFormationPanel } from "./NodeDaoFormationPanel.client";
import { NodeStatusBar } from "./NodeStatusBar";

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

  const repoPath = `Cogni-DAO/cogni/nodes/${node.slug}`;
  const technical: ReadonlyArray<{
    label: string;
    value: string;
    href?: string;
  }> = [
    {
      label: "Repo path",
      value: repoPath,
      href: `https://github.com/Cogni-DAO/cogni/tree/main/nodes/${node.slug}`,
    },
    { label: "Chain", value: String(node.chainId ?? "—") },
    ...(node.daoAddress ? [{ label: "DAO", value: node.daoAddress }] : []),
    ...(node.operatorWalletAddress
      ? [{ label: "Operator wallet", value: node.operatorWalletAddress }]
      : []),
    ...(node.splitAddress
      ? [{ label: "Payment split", value: node.splitAddress }]
      : []),
    ...(node.publishPrUrl
      ? [
          {
            label: "Governance PR",
            value: node.publishPrUrl,
            href: node.publishPrUrl,
          },
        ]
      : []),
  ];

  return (
    <PageContainer maxWidth="3xl">
      <Link
        href="/setup/nodes"
        className="inline-flex items-center gap-1.5 text-muted-foreground text-sm hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Nodes
      </Link>

      <SectionCard title={node.slug}>
        <NodeStatusBar status={status} />
        <p className="text-muted-foreground text-sm">{display.description}</p>
        {node.publishPrUrl ? (
          <a
            className="inline-flex text-primary text-sm underline"
            href={node.publishPrUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            View governance PR →
          </a>
        ) : null}
        {node.failureReason ? (
          <p className="text-destructive text-sm">{node.failureReason}</p>
        ) : null}
      </SectionCard>

      {status === "dao_pending" ? (
        <NodeDaoFormationPanel nodeId={node.id} />
      ) : (
        <SectionCard title="Next step">
          <NodeActionPanel nodeId={node.id} status={status} />
        </SectionCard>
      )}

      <details className="px-1 text-sm">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
          Technical details
        </summary>
        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5">
          {technical.map((row) => (
            <Fragment key={row.label}>
              <span className="text-muted-foreground">{row.label}</span>
              {row.href ? (
                <a
                  className="break-all font-mono text-primary text-xs underline"
                  href={row.href}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {row.value}
                </a>
              ) : (
                <span className="break-all font-mono text-xs">{row.value}</span>
              )}
            </Fragment>
          ))}
        </div>
      </details>
    </PageContainer>
  );
}
