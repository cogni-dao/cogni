// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/setup/nodes/page`
 * Purpose: Landing page for the node setup wizard. Lists the user's in-flight + active node
 *   rows and offers a form to register a new managed node.
 * Scope: Server component. Owner-scoped DB read; delegates create UX to client component.
 * Links: task.5083
 * @public
 */

import { withTenantScope } from "@cogni/db-client";
import { type UserId, userActor } from "@cogni/ids";
import { desc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import type { ReactElement } from "react";
import { resolveAppDb } from "@/bootstrap/container";
import { PageContainer, SectionCard } from "@/components";
import { NodeTile } from "@/features/nodes/components/NodeTile";
import { getServerSessionUser } from "@/lib/auth/server";
import { type NodeStatus, nodes } from "@/shared/db/nodes";

import { NewNodeForm } from "./NewNodeForm.client";
import { NODE_STATUS_DISPLAY } from "./node-display";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function SetupNodesPage(): Promise<ReactElement> {
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
        .select()
        .from(nodes)
        .where(eq(nodes.ownerUserId, session.id))
        .orderBy(desc(nodes.createdAt))
        .limit(50)
  );

  return (
    <PageContainer maxWidth="3xl">
      <SectionCard title="Register a node">
        <p className="mb-3 text-muted-foreground text-sm">
          Register a node, form its DAO, then create its repo and deployment
          pin.
        </p>
        <NewNodeForm />
      </SectionCard>

      <SectionCard title="Your nodes">
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No nodes yet — register one above to get started.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {rows.map((n) => {
              const display = NODE_STATUS_DISPLAY[n.status as NodeStatus];
              return (
                <NodeTile
                  key={n.id}
                  node={{
                    title: n.slug,
                    tagline: display.description,
                    href: `/setup/nodes/${n.id}`,
                    status: { label: display.label, intent: display.intent },
                  }}
                />
              );
            })}
          </div>
        )}
      </SectionCard>
    </PageContainer>
  );
}
