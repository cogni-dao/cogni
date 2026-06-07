// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/developers`
 * Purpose: Owner-gated approval surface for node developer flighting authority.
 * Scope: Browser-session owners approve/reject registered agent users for one node by writing/removing OpenFGA `developer` tuples.
 * Invariants: OWNER_GATING, OPENFGA_IS_AUTHORITY, NO_LOCAL_ROLE_TABLE.
 * Side-effects: IO (Postgres read, OpenFGA tuple write/delete)
 * Links: docs/spec/rbac.md, docs/spec/identity-model.md
 * @public
 */

import { withTenantScope } from "@cogni/db-client";
import { users } from "@cogni/db-schema/refs";
import { type UserId, userActor } from "@cogni/ids";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import {
  getContainer,
  resolveAppDb,
  resolveServiceDb,
} from "@/bootstrap/container";
import { getServerSessionUser } from "@/lib/auth/server";
import { nodes } from "@/shared/db/nodes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DeveloperDecisionInput = z.object({
  agentUserId: z.string().uuid(),
  decision: z.enum(["approve", "reject"]),
});

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, ctx: RouteParams) {
  const session = await getServerSessionUser();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const parsed = DeveloperDecisionInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid input", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const { id } = await ctx.params;
  const db = resolveAppDb();
  const existing = await withTenantScope(
    db,
    userActor(session.id as UserId),
    async (tx) =>
      tx
        .select({ id: nodes.id })
        .from(nodes)
        .where(and(eq(nodes.id, id), eq(nodes.ownerUserId, session.id)))
        .limit(1)
  );
  if (!existing[0]) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const serviceDb = resolveServiceDb();
  const agentUsers = await serviceDb
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, parsed.data.agentUserId))
    .limit(1);
  if (!agentUsers[0]) {
    return NextResponse.json(
      { error: "agent user not found" },
      { status: 404 }
    );
  }

  const authorization = getContainer().authorization;
  if (!authorization) {
    return NextResponse.json(
      {
        error: "authorization not configured",
        errorCode: "authz_unavailable",
      },
      { status: 503 }
    );
  }

  const tuple = {
    user: `user:${parsed.data.agentUserId}`,
    relation: "developer",
    object: `node:${id}`,
  };
  const write =
    parsed.data.decision === "approve"
      ? await authorization.writeRelation(tuple)
      : await authorization.deleteRelation(tuple);

  if (write.decision !== "success") {
    return NextResponse.json(
      {
        error: "authorization write unavailable",
        errorCode: write.code,
      },
      { status: 503 }
    );
  }

  return NextResponse.json({
    nodeId: id,
    agentUserId: parsed.data.agentUserId,
    decision: parsed.data.decision,
  });
}
