// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/provision-wallet`
 * Purpose: Server-side Privy wallet creation for the registered node; advances dao_formed → wallet_ready.
 * Scope: Owner-gated. Idempotent: if a wallet is already provisioned, returns the existing address.
 * Invariants: KEY_NEVER_LEAVES_PRIVY, OWNER_GATING, STATE_MACHINE_TOTAL.
 * Side-effects: IO (Privy API, Postgres)
 * Links: scripts/provision-operator-wallet.ts, task.5083
 * @public
 */

import { withTenantScope } from "@cogni/db-client";
import { type UserId, userActor } from "@cogni/ids";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { provisionNodeWallet } from "@/bootstrap/capabilities/node-wallet";
import { resolveAppDb } from "@/bootstrap/container";
import { transition } from "@/features/nodes/state-machine";
import { getServerSessionUser } from "@/lib/auth/server";
import { type NodeStatus, nodes } from "@/shared/db/nodes";
import { serverEnv } from "@/shared/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(_request: Request, ctx: RouteParams) {
  const session = await getServerSessionUser();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const env = serverEnv();
  if (!env.PRIVY_APP_ID || !env.PRIVY_APP_SECRET) {
    return NextResponse.json(
      {
        error: "operator not configured for wallet provisioning",
        reason: "PRIVY_APP_ID and PRIVY_APP_SECRET must be set on the operator",
      },
      { status: 503 }
    );
  }

  const { id } = await ctx.params;
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
  const node = existing[0];
  if (!node) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Idempotent: if already provisioned, return the existing address.
  if (node.operatorWalletAddress) {
    return NextResponse.json({
      node,
      alreadyProvisioned: true,
    });
  }

  const t = transition(node.status as NodeStatus, {
    type: "wallet_provisioned",
  });
  if (!t.ok) {
    return NextResponse.json(
      {
        error: "invalid state for wallet provisioning",
        reason: t.reason,
        currentStatus: node.status,
      },
      { status: 409 }
    );
  }

  const wallet = await provisionNodeWallet(env);

  const [updated] = await withTenantScope(
    db,
    userActor(session.id as UserId),
    async (tx) =>
      tx
        .update(nodes)
        .set({
          operatorWalletAddress: wallet.address,
          operatorWalletPrivyId: wallet.privyWalletId,
          status: t.nextStatus,
          updatedAt: new Date(),
        })
        .where(and(eq(nodes.id, id), eq(nodes.ownerUserId, session.id)))
        .returning()
  );

  return NextResponse.json({ node: updated });
}
