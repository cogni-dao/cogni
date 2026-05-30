// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]`
 * Purpose: GET + PATCH for a single node-registry row.
 * Scope: Owner-gated. PATCH accepts the address fields the wizard fills in progressively + a
 *   state-machine event token to advance status atomically.
 * Invariants: OWNER_GATING, STATE_MACHINE_TOTAL — transitions go through `transition()`.
 * Side-effects: IO (Postgres)
 * Links: src/features/nodes/state-machine.ts, task.5083
 * @public
 */

import { withTenantScope } from "@cogni/db-client";
import { type UserId, userActor } from "@cogni/ids";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveAppDb } from "@/bootstrap/container";
import { type NodeEvent, transition } from "@/features/nodes/state-machine";
import { getServerSessionUser } from "@/lib/auth/server";
import { type NodeStatus, nodes } from "@/shared/db/nodes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PatchInput = z.object({
  event: z
    .discriminatedUnion("type", [
      z.object({ type: z.literal("dao_verified") }),
      z.object({ type: z.literal("split_deployed") }),
      z.object({ type: z.literal("fail"), reason: z.string().min(1) }),
    ])
    .optional(),
  daoAddress: z.string().optional(),
  pluginAddress: z.string().optional(),
  signalAddress: z.string().optional(),
  tokenAddress: z.string().optional(),
  daoTxHash: z.string().optional(),
  signalTxHash: z.string().optional(),
  signalBlockNumber: z.number().int().nonnegative().optional(),
  splitAddress: z.string().optional(),
  splitTxHash: z.string().optional(),
});

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, ctx: RouteParams) {
  const session = await getServerSessionUser();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
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
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ node });
}

export async function PATCH(request: Request, ctx: RouteParams) {
  const session = await getServerSessionUser();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const parsed = PatchInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid input", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const db = resolveAppDb();
  const existing = await withTenantScope(
    db,
    userActor(session.id as UserId),
    async (tx) =>
      tx
        .select()
        .from(nodes)
        .where(and(eq(nodes.id, id), eq(nodes.ownerUserId, session.id)))
        .limit(1)
  );

  const current = existing[0];
  if (!current) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  let nextStatus: NodeStatus = current.status as NodeStatus;
  let failureReason: string | null = current.failureReason;
  if (parsed.data.event) {
    const r = transition(nextStatus, parsed.data.event as NodeEvent);
    if (!r.ok) {
      return NextResponse.json(
        {
          error: "invalid state transition",
          reason: r.reason,
          currentStatus: nextStatus,
        },
        { status: 409 }
      );
    }
    nextStatus = r.nextStatus;
    if (parsed.data.event.type === "fail") {
      failureReason = parsed.data.event.reason;
    }
  }

  const patch: Partial<typeof nodes.$inferInsert> = {
    status: nextStatus,
    failureReason,
    updatedAt: new Date(),
  };
  if (parsed.data.daoAddress !== undefined)
    patch.daoAddress = parsed.data.daoAddress;
  if (parsed.data.pluginAddress !== undefined)
    patch.pluginAddress = parsed.data.pluginAddress;
  if (parsed.data.signalAddress !== undefined)
    patch.signalAddress = parsed.data.signalAddress;
  if (parsed.data.tokenAddress !== undefined)
    patch.tokenAddress = parsed.data.tokenAddress;
  if (parsed.data.daoTxHash !== undefined)
    patch.daoTxHash = parsed.data.daoTxHash;
  if (parsed.data.signalTxHash !== undefined)
    patch.signalTxHash = parsed.data.signalTxHash;
  if (parsed.data.signalBlockNumber !== undefined)
    patch.signalBlockNumber = parsed.data.signalBlockNumber;
  if (parsed.data.splitAddress !== undefined)
    patch.splitAddress = parsed.data.splitAddress;
  if (parsed.data.splitTxHash !== undefined)
    patch.splitTxHash = parsed.data.splitTxHash;

  const [updated] = await withTenantScope(
    db,
    userActor(session.id as UserId),
    async (tx) =>
      tx
        .update(nodes)
        .set(patch)
        .where(and(eq(nodes.id, id), eq(nodes.ownerUserId, session.id)))
        .returning()
  );

  return NextResponse.json({ node: updated });
}
