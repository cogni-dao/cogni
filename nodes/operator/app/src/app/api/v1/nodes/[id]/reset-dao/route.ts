// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/reset-dao`
 * Purpose: Owner-only destructive reset of a node's DAO record in the OPERATOR registry: clears
 *   `daoAddress` + `tokenAddress` and returns the node to `dao_pending` so the formation wizard's
 *   DAO step is available again to re-form a fresh DAO.
 * Scope: Session auth + OWNER-ONLY gating (no developer/flight fallback — this is destructive).
 *   Requires a typed confirmation (`confirm === "clear <slug> dao"`) and only acts when the node
 *   actually HAS a DAO to reset.
 * Invariants:
 *   - OWNER_ONLY: only `node.ownerUserId === sessionUser.id` may reset; never falls back to node.flight.
 *   - TYPED_CONFIRMATION: server re-validates `confirm` against `clear ${slug} dao` (exact match).
 *   - HAS_DAO_TO_RESET: rejects when there is no DAO recorded (nothing to reset).
 *   - OPERATOR_RECORD_ONLY: this resets the OPERATOR's DAO record ONLY. It does NOT revert the node
 *     repo-spec governance/distributions section — that repo-side revert is a documented follow-up,
 *     out of scope for V0.
 * Side-effects: IO (Postgres)
 * Links: src/app/api/v1/nodes/[id]/activate-distributions/route.ts, src/shared/db/nodes.ts
 * @public
 */

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveServiceDb } from "@/bootstrap/container";
import { withRootSpan } from "@/bootstrap/otel";
import { nodeIdOrSlug } from "@/features/nodes/node-lookup";
import { type NodeStatus, nodes } from "@/shared/db/nodes";
import {
  createRequestContext,
  EVENT_NAMES,
  makeLogger,
} from "@/shared/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE_ID = "v1.nodes.reset-dao";

const baseLog = makeLogger();
const clock = { now: () => new Date().toISOString() };

const ResetDaoInput = z.object({
  confirm: z.string(),
});

interface RouteParams {
  params: Promise<{ id: string }>;
}

// A node "has a DAO" to reset if it records a DAO address OR its status has
// advanced past the initial `dao_pending` state (i.e. formation produced a DAO).
function hasDaoToReset(node: typeof nodes.$inferSelect): boolean {
  const status = node.status as NodeStatus;
  return node.daoAddress != null || status !== "dao_pending";
}

export async function POST(
  request: Request,
  routeArgs: RouteParams
): Promise<NextResponse> {
  return withRootSpan(
    "POST nodes.reset-dao",
    { route_id: ROUTE_ID },
    async ({ traceId }) => {
      const ctx = createRequestContext({ baseLog, clock }, request, {
        routeId: ROUTE_ID,
        traceId,
      });
      return handleResetDao(request, routeArgs, ctx);
    }
  );
}

async function handleResetDao(
  request: Request,
  routeArgs: RouteParams,
  ctx: ReturnType<typeof createRequestContext>
): Promise<NextResponse> {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await routeArgs.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const parsed = ResetDaoInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid input", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const db = resolveServiceDb();
  const existing = await db
    .select()
    .from(nodes)
    .where(nodeIdOrSlug(id))
    .limit(1);
  const node = existing[0];
  if (!node) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // OWNER_ONLY: destructive, so only the node owner may reset. No node.flight fallback.
  const isOwner = node.ownerUserId === sessionUser.id;
  if (!isOwner) {
    return NextResponse.json({ error: "not authorized" }, { status: 403 });
  }

  ctx.log.info(
    {
      event: "node.dao_reset.requested",
      reqId: ctx.reqId,
      routeId: ctx.routeId,
      nodeId: node.id,
      slug: node.slug,
      currentStatus: node.status,
    },
    "reset-dao: reset requested"
  );

  // TYPED_CONFIRMATION: server re-validates the exact confirmation string.
  const expected = `clear ${node.slug} dao`;
  if (parsed.data.confirm !== expected) {
    return NextResponse.json(
      { error: "confirmation mismatch", expected },
      { status: 400 }
    );
  }

  // HAS_DAO_TO_RESET: nothing to do if there is no DAO recorded.
  if (!hasDaoToReset(node)) {
    return NextResponse.json(
      { error: "no dao to reset", currentStatus: node.status },
      { status: 409 }
    );
  }

  const previousStatus = node.status;
  const previousDao = node.daoAddress;
  const previousToken = node.tokenAddress;

  let updated: typeof nodes.$inferSelect | undefined;
  try {
    const rows = await db
      .update(nodes)
      .set({
        daoAddress: null,
        tokenAddress: null,
        status: "dao_pending",
        updatedAt: new Date(),
      })
      .where(eq(nodes.id, node.id))
      .returning();
    updated = rows[0];
  } catch (err) {
    const reason = err instanceof Error ? err.message : "unknown";
    ctx.log.error(
      {
        event: "node.dao_reset.failed",
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        nodeId: node.id,
        slug: node.slug,
        err: reason,
        stack: err instanceof Error ? err.stack : undefined,
      },
      "reset-dao: reset failed"
    );
    return NextResponse.json(
      { error: "dao reset failed", reason },
      { status: 502 }
    );
  }

  if (!updated) {
    ctx.log.error(
      {
        event: "node.dao_reset.failed",
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        nodeId: node.id,
        slug: node.slug,
        err: "update returned no row",
      },
      "reset-dao: reset failed"
    );
    return NextResponse.json(
      { error: "dao reset failed", reason: "update returned no row" },
      { status: 502 }
    );
  }

  ctx.log.info(
    {
      event: EVENT_NAMES.NODE_DAO_RESET_COMPLETE,
      reqId: ctx.reqId,
      routeId: ctx.routeId,
      nodeId: node.id,
      slug: node.slug,
      previousStatus,
      previousDao,
      previousToken,
    },
    "reset-dao: reset complete"
  );

  return NextResponse.json({
    node: {
      id: updated.id,
      slug: updated.slug,
      status: updated.status,
      daoAddress: updated.daoAddress,
      tokenAddress: updated.tokenAddress,
    },
  });
}
