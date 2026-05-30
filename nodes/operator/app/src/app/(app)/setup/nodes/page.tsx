// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/setup/nodes/page`
 * Purpose: Landing page for the node setup wizard. Lists the user's in-flight + active node
 *   rows and offers a form to register a new monorepo-internal node.
 * Scope: Server component. Owner-scoped DB read; delegates create UX to client component.
 * Links: task.5083
 * @public
 */

import { withTenantScope } from "@cogni/db-client";
import { type UserId, userActor } from "@cogni/ids";
import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactElement } from "react";
import { resolveAppDb } from "@/bootstrap/container";
import { PageContainer, SectionCard } from "@/components";
import { getServerSessionUser } from "@/lib/auth/server";
import { nodes } from "@/shared/db/nodes";

import { NewNodeForm } from "./NewNodeForm.client";

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
    <PageContainer>
      <SectionCard title="Register a node">
        <p className="mb-3 text-muted-foreground text-sm">
          Bootstrap a Cogni-governed node. v0 nodes live at{" "}
          <code>nodes/&lt;slug&gt;/</code> in the Cogni-DAO/cogni monorepo — the
          operator opens one PR adding the governance repo-spec once you have
          formed its DAO. Payment activation happens from the child node after
          bootstrap.
        </p>
        <NewNodeForm />
      </SectionCard>

      <SectionCard title="Your nodes">
        <p className="mb-3 text-muted-foreground text-sm">
          {rows.length} registered
        </p>
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No nodes yet — register one above to start the bootstrap wizard.
          </p>
        ) : (
          <ul className="space-y-2">
            {rows.map((n) => (
              <li key={n.id}>
                <Link
                  href={`/setup/nodes/${n.id}`}
                  className="block rounded border border-border p-3 hover:bg-muted"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-sm">{n.repoUrl}</span>
                    <span className="text-muted-foreground text-xs uppercase">
                      {n.status}
                    </span>
                  </div>
                  {n.failureReason ? (
                    <p className="mt-1 text-destructive text-xs">
                      {n.failureReason}
                    </p>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </PageContainer>
  );
}
