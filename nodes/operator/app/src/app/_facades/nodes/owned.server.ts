// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_facades/nodes/owned.server`
 * Purpose: Minimal owner-scoped read model for the authenticated `/nodes` index.
 * Scope: Resolves the app database and returns only fields required by the list UI.
 * Invariants: OWNER_GATING; never contacts node registries, probes, or deployment providers.
 * Side-effects: IO (one tenant-scoped database query) and one terminal structured log.
 * Links: src/app/(app)/nodes/page.tsx, bug.5445
 * @public
 */

import { randomUUID } from "node:crypto";
import { withTenantScope } from "@cogni/db-client";
import { type UserId, userActor } from "@cogni/ids";
import { desc, eq } from "drizzle-orm";
import { resolveAppDb } from "@/bootstrap/container";
import { type NodeStatus, nodes } from "@/shared/db/nodes";
import { EVENT_NAMES, makeLogger } from "@/shared/observability";

const logger = makeLogger({ component: "OwnedNodesFacade" });

export interface OwnedNodeListItem {
  readonly id: string;
  readonly slug: string;
  readonly status: NodeStatus;
}

/** Read the current user's newest node rows without resolving remote node metadata. */
export async function listOwnedNodes(
  ownerUserId: string
): Promise<readonly OwnedNodeListItem[]> {
  const startedAt = performance.now();
  const reqId = randomUUID();

  try {
    const db = resolveAppDb();
    const rows = await withTenantScope(
      db,
      userActor(ownerUserId as UserId),
      async (tx) =>
        tx
          .select({ id: nodes.id, slug: nodes.slug, status: nodes.status })
          .from(nodes)
          .where(eq(nodes.ownerUserId, ownerUserId))
          .orderBy(desc(nodes.createdAt))
          .limit(50)
    );

    logger.info(
      {
        event: EVENT_NAMES.NODE_OWNER_LIST_COMPLETE,
        reqId,
        routeId: "nodes.index",
        outcome: "success",
        resultCount: rows.length,
        durationMs: performance.now() - startedAt,
      },
      EVENT_NAMES.NODE_OWNER_LIST_COMPLETE
    );

    return rows.map((row) => ({
      ...row,
      status: row.status as NodeStatus,
    }));
  } catch (error) {
    logger.error(
      {
        event: EVENT_NAMES.NODE_OWNER_LIST_COMPLETE,
        reqId,
        routeId: "nodes.index",
        outcome: "error",
        reason: "owner_read_failed",
        errorName: error instanceof Error ? error.name : typeof error,
        durationMs: performance.now() - startedAt,
      },
      EVENT_NAMES.NODE_OWNER_LIST_COMPLETE
    );
    throw error;
  }
}
