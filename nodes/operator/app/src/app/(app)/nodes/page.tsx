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
import { type ReactElement, Suspense } from "react";
import { listOwnedNodes } from "@/app/_facades/nodes/owned.server";
import { PageContainer, SectionCard } from "@/components";
import { CardGridSkeleton } from "@/components/kit/layout/CardGridSkeleton";
import { NodeTile } from "@/features/nodes/components/NodeTile";
import { nodeSummaryToTileView } from "@/features/nodes/components/nodeTileView";
import { getServerSessionUser } from "@/lib/auth/server";
import { titleCaseSlug } from "@/shared/node-registry/resolve";

import { NewNodeForm } from "./NewNodeForm.client";
import { NODE_STATUS_DISPLAY } from "./node-display";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function loadOwnedNodes() {
  const session = await getServerSessionUser();
  if (!session) {
    redirect("/");
  }

  return listOwnedNodes(session.id);
}

function OwnedNodesPending(): ReactElement {
  return (
    <section className="space-y-4" aria-busy="true">
      <h1 className="font-bold text-3xl text-foreground tracking-tight">
        Your nodes
      </h1>
      <CardGridSkeleton
        count={3}
        cols={{ base: 1, md: 2, lg: 3 }}
        cardHeight="h-48"
      />
    </section>
  );
}

async function OwnedNodesSection({
  rowsPromise,
}: {
  readonly rowsPromise: ReturnType<typeof loadOwnedNodes>;
}): Promise<ReactElement> {
  const rows = await rowsPromise;
  return <OwnedNodesContent rows={rows} />;
}

export function OwnedNodesContent({
  rows,
}: {
  readonly rows: Awaited<ReturnType<typeof loadOwnedNodes>>;
}): ReactElement {
  return (
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
                    // The dynamic detail route performs uncached operational reads.
                    // Prefetching every tile caused duplicate 20s RSC work before click.
                    prefetch: false,
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
  );
}

export default function SetupNodesPage(): ReactElement {
  const rowsPromise = loadOwnedNodes();

  return (
    <PageContainer maxWidth="full" className="max-w-7xl">
      <SectionCard title="Register a node" className="mx-auto w-full max-w-3xl">
        <NewNodeForm />
      </SectionCard>

      <Suspense fallback={<OwnedNodesPending />}>
        <OwnedNodesSection rowsPromise={rowsPromise} />
      </Suspense>
    </PageContainer>
  );
}
