// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes`
 * Purpose: List + create rows in the operator's node registry.
 * Scope: Owner-scoped reads via RLS; writes use a session-derived owner_user_id. Managed nodes get
 *   their own repo and a deployment pin at `nodes/<slug>/` in the operator's repo.
 * Invariants: OWNER_GATING, NODES_TABLE_SCOPE (operator-managed — slug, not user-provided URL), USER_ROW_ENSURED,
 *   OPENFGA_IS_AUTHORITY (creation seeds the owner→admin tuple; best-effort where no store exists).
 * Side-effects: IO (Postgres write, best-effort OpenFGA tuple write)
 * Links: task.5083, story.5009, docs/spec/rbac.md
 * @public
 */

import { withTenantScope } from "@cogni/db-client";
import { users } from "@cogni/db-schema/refs";
import { type UserId, userActor } from "@cogni/ids";
import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getContainer, resolveAppDb } from "@/bootstrap/container";
import { getCurrentTraceId } from "@/bootstrap/otel";
import { parseNodeSlug } from "@/features/nodes/node-slug";
import { getServerSessionUser } from "@/lib/auth/server";
import { getGithubRepo } from "@/shared/config";
import { nodes } from "@/shared/db/nodes";
import {
  createRequestContext,
  EVENT_NAMES,
  logEvent,
  makeLogger,
} from "@/shared/observability";
import { SUPPORTED_CHAIN_IDS } from "@/shared/web3";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const baseLog = makeLogger();
const clock = { now: () => new Date().toISOString() };

const SUPPORTED_CHAIN_ID_LIST: readonly number[] = SUPPORTED_CHAIN_IDS;

const CreateNodeInput = z.object({
  slug: z.string().min(1),
  chainId: z
    .number()
    .int()
    .refine((n) => SUPPORTED_CHAIN_ID_LIST.includes(n), {
      message: `chainId must be one of: ${SUPPORTED_CHAIN_ID_LIST.join(", ")}`,
    }),
});

export async function GET() {
  const session = await getServerSessionUser();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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

  return NextResponse.json({ nodes: rows });
}

export async function POST(request: Request) {
  const startTime = performance.now();
  const session = await getServerSessionUser();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const ctx = createRequestContext({ baseLog, clock }, request, {
    routeId: "nodes.create",
    traceId: getCurrentTraceId(),
    session,
  });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const parsed = CreateNodeInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid input", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const parsedSlug = parseNodeSlug(parsed.data.slug);
  if (!parsedSlug.ok) {
    return NextResponse.json(
      { error: "invalid slug", reason: parsedSlug.reason },
      { status: 400 }
    );
  }

  const db = resolveAppDb();

  // USER_ROW_ENSURED: the nodes FK references users.id. A freshly-authenticated
  // session may not yet have a users row materialized (the cause of the
  // candidate-a 500). Ensure it exists before the FK insert. Idempotent.
  await withTenantScope(db, userActor(session.id as UserId), async (tx) =>
    tx
      .insert(users)
      .values({
        id: session.id,
        walletAddress: session.walletAddress ?? null,
        name: session.displayName ?? null,
      })
      .onConflictDoNothing({ target: users.id })
  );

  const monorepo = getGithubRepo();
  const repoUrl = `https://github.com/${monorepo.owner}/${monorepo.repo}`;

  const inserted = await withTenantScope(
    db,
    userActor(session.id as UserId),
    async (tx) =>
      tx
        .insert(nodes)
        .values({
          slug: parsedSlug.value.slug,
          repoUrl,
          repoOwner: monorepo.owner,
          repoName: monorepo.repo,
          repoVisibility: "public",
          ownerUserId: session.id,
          chainId: parsed.data.chainId,
          status: "dao_pending",
        })
        .onConflictDoNothing({ target: nodes.slug })
        .returning()
  );

  if (inserted.length === 0) {
    const existing = await withTenantScope(
      db,
      userActor(session.id as UserId),
      async (tx) =>
        tx
          .select()
          .from(nodes)
          .where(eq(nodes.slug, parsedSlug.value.slug))
          .limit(1)
    );
    const reason =
      existing.length > 0
        ? "A node with this slug already exists. Open it from Your nodes or choose another slug."
        : "Slug already taken by another user.";
    logEvent(ctx.log, EVENT_NAMES.NODE_FORMATION_CREATE_COMPLETE, {
      reqId: ctx.reqId,
      routeId: ctx.routeId,
      outcome: "error",
      errorCode: "slug_taken",
      chainId: parsed.data.chainId,
      durationMs: Math.round(performance.now() - startTime),
    });
    return NextResponse.json(
      { error: "slug already taken", reason },
      { status: 409 }
    );
  }

  const createdNode = inserted[0];

  // OPENFGA_IS_AUTHORITY: seed the owner→admin tuple so the creator can immediately act on
  // the node (flight / manage_secrets / promote_production all derive from `admin`). Without
  // this, every node-scoped route returns authz_denied for the owner on stores-enabled envs
  // (candidate-a) — a latent bug for all wizard nodes, not just first-class registrations.
  // Best-effort + idempotent (writeRelation uses onDuplicateWrites:"ignore"): on envs with no
  // OpenFGA store (prod/preview today) `authorization` is undefined and node-scoped routes
  // fall back to the owner check, so skipping the seed there is correct, not a regression.
  const authorization = getContainer().authorization;
  let adminTupleSeeded = false;
  if (authorization) {
    const seed = await authorization.writeRelation({
      user: `user:${session.id}`,
      relation: "admin",
      object: `node:${createdNode.id}`,
    });
    adminTupleSeeded = seed.decision === "success";
    if (!adminTupleSeeded) {
      // The row exists but the owner cannot yet act on it. Surface loudly; a reconcile/
      // re-seed path is owned by the existing-repo registration slice (story.5009).
      ctx.log.error(
        {
          event: "node.admin_tuple_seed_failed",
          reqId: ctx.reqId,
          routeId: ctx.routeId,
          nodeId: createdNode.id,
          errorCode: seed.code,
        },
        "node.admin_tuple_seed_failed"
      );
    }
  }

  logEvent(ctx.log, EVENT_NAMES.NODE_FORMATION_CREATE_COMPLETE, {
    reqId: ctx.reqId,
    routeId: ctx.routeId,
    outcome: "success",
    slug: parsedSlug.value.slug,
    chainId: parsed.data.chainId,
    adminTupleSeeded,
    durationMs: Math.round(performance.now() - startTime),
  });
  return NextResponse.json({ node: createdNode }, { status: 201 });
}
