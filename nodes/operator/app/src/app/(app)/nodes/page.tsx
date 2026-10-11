// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/nodes/page`
 * Purpose: Landing page for the node setup wizard. Lists the user's in-flight + active node
 *   rows and offers a form to register a new managed node.
 * Scope: Server component. Owner-scoped DB read; delegates create UX to client component.
 * Links: task.5083
 * @public
 */

import { redirect } from "next/navigation";
import type { ReactElement } from "react";
import { listOwnedNodes } from "@/app/_facades/nodes/owned.server";
import { PageContainer, SectionCard } from "@/components";
import { NodeTile } from "@/features/nodes/components/NodeTile";
import { nodeSummaryToTileView } from "@/features/nodes/components/nodeTileView";
import { getServerSessionUser } from "@/lib/auth/server";
import { titleCaseSlug } from "@/shared/node-registry/resolve";

import { NewNodeForm } from "./NewNodeForm.client";
import { NODE_STATUS_DISPLAY } from "./node-display";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function SetupNodesPage(): Promise<ReactElement> {
  const session = await getServerSessionUser();
  if (!session) {
    redirect("/");
  }

  const rows = await listOwnedNodes(session.id);

  return (
    <PageContainer maxWidth="full" className="max-w-7xl">
      <SectionCard title="Register a node" className="mx-auto w-full max-w-3xl">
        <NewNodeForm />
      </SectionCard>

      <section className="space-y-4">
        <h1 className="font-bold text-3xl text-foreground tracking-tight">
          Your nodes
        </h1>
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No nodes yet — register one above to get started.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {rows.map((n) => {
              const display = NODE_STATUS_DISPLAY[n.status];
              return (
                <NodeTile
                  key={n.id}
                  node={nodeSummaryToTileView(
                    {
                      slug: n.slug,
                      nodeId: n.id,
                      title: titleCaseSlug(n.slug),
                      tagline: "",
                      kind: "full-app",
                      href: `/nodes/${n.id}`,
                    },
                    {
                      href: `/nodes/${n.id}`,
                      status: {
                        label: display.label,
                        intent: display.intent,
                        presentation: "dot",
                      },
                      density: "compact",
                    }
                  )}
                />
              );
            })}
          </div>
        )}
      </section>
    </PageContainer>
  );
}
