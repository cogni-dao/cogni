// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_lib/owned-node-read`
 * Purpose: Owner-scoped node reads with one correlated terminal event.
 * Scope: Delivery composition; node-reference interpretation remains in node-lookup.
 * Invariants: Preserve RLS and owner predicates; never log raw references or override emitter identity.
 * Side-effects: IO (Postgres and structured logs); reads headers for server pages.
 * Links: src/features/nodes/node-lookup.ts, docs/spec/identity-model.md
 * @internal
 */

import { withTenantScope } from "@cogni/db-client";
import { type UserId, userActor } from "@cogni/ids";
import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";

import { getContainer, resolveAppDb } from "@/bootstrap/container";
import { getCurrentTraceId } from "@/bootstrap/otel";
import { nodeIdOrSlug } from "@/features/nodes/node-lookup";
import { nodes } from "@/shared/db/nodes";
import {
  createRequestContext,
  EVENT_NAMES,
  logEvent,
} from "@/shared/observability";

export async function readOwnedNode(input: {
  readonly id: string;
  readonly userId: string;
  readonly routeId:
    | "nodes.detail"
    | "nodes.payments"
    | "nodes.read"
    | "nodes.launch_pack";
  readonly request?: Request;
}): Promise<typeof nodes.$inferSelect | undefined> {
  const container = getContainer();
  const request =
    input.request ??
    new Request("https://node-read.invalid", {
      headers: new Headers(await headers()),
    });
  const ctx = createRequestContext(
    { baseLog: container.log, clock: container.clock },
    request,
    {
      routeId: input.routeId,
      traceId: getCurrentTraceId(),
    }
  );
  const startedAt = performance.now();
  let status = 500;
  let errorCode: "registry_unavailable" | "node_not_found" | undefined =
    "registry_unavailable";
  let targetNodeId: string | undefined;
  try {
    const rows = await withTenantScope(
      resolveAppDb(),
      userActor(input.userId as UserId),
      async (tx) =>
        tx
          .select()
          .from(nodes)
          .where(
            and(nodeIdOrSlug(input.id), eq(nodes.ownerUserId, input.userId))
          )
          .limit(1)
    );
    const node = rows[0];
    targetNodeId = node?.id;
    status = node ? 200 : 404;
    errorCode = node ? undefined : "node_not_found";
    return node;
  } finally {
    logEvent(ctx.log, EVENT_NAMES.NODE_REFERENCE_READ_COMPLETE, {
      reqId: ctx.reqId,
      routeId: ctx.routeId,
      status,
      outcome: status === 200 ? "success" : "error",
      errorCode,
      targetNodeId,
      durationMs: Math.round(performance.now() - startedAt),
    });
  }
}
