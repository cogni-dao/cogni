// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/setup/dao/page`
 * Purpose: Server entrypoint for DAO formation. Standalone mode preserves the legacy YAML flow;
 *   node-registry mode decorates the wallet flow with the node state-machine progress.
 * Scope: Owner-scoped DB read only when `nodeId` is present; wallet transactions stay client-side.
 * Invariants: Requires authenticated session (wallet connected) via (app) route group.
 * Side-effects: none (server render only)
 * Links: docs/spec/node-formation.md
 * @public
 */

import { withTenantScope } from "@cogni/db-client";
import { type UserId, userActor } from "@cogni/ids";
import { and, eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import type { ReactElement } from "react";
import { resolveAppDb } from "@/bootstrap/container";
import { getServerSessionUser } from "@/lib/auth/server";
import { type NodeStatus, nodes } from "@/shared/db/nodes";

import { DAOFormationPageClient } from "./DAOFormationPage.client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function DAOFormationPage({
  searchParams,
}: PageProps): Promise<ReactElement> {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const rawNodeId = resolvedSearchParams.nodeId;
  const nodeId = Array.isArray(rawNodeId) ? rawNodeId[0] : rawNodeId;

  if (!nodeId) {
    return <DAOFormationPageClient />;
  }

  const session = await getServerSessionUser();
  if (!session) {
    redirect("/");
  }

  const db = resolveAppDb();
  const rows = await withTenantScope(
    db,
    userActor(session.id as UserId),
    async (tx) =>
      tx
        .select({ status: nodes.status, repoUrl: nodes.repoUrl })
        .from(nodes)
        .where(and(eq(nodes.id, nodeId), eq(nodes.ownerUserId, session.id)))
        .limit(1)
  );
  const node = rows[0];
  if (!node) {
    notFound();
  }

  return (
    <DAOFormationPageClient
      nodeStatus={node.status as NodeStatus}
      nodeRepoUrl={node.repoUrl}
    />
  );
}
