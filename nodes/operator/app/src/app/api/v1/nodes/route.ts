// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes`
 * Purpose: List + create rows in the operator's node registry.
 * Scope: Owner-scoped reads via RLS; writes use a session-derived owner_user_id. v0 nodes are
 *   monorepo-internal — a node lives at `nodes/<slug>/` in the operator's own repo (Cogni-DAO/cogni).
 * Invariants: OWNER_GATING, NODES_TABLE_SCOPE (monorepo-internal — slug, not external URL), USER_ROW_ENSURED.
 * Side-effects: IO (Postgres)
 * Links: task.5083
 * @public
 */

import { withTenantScope } from "@cogni/db-client";
import { users } from "@cogni/db-schema/refs";
import { type UserId, userActor } from "@cogni/ids";
import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveAppDb } from "@/bootstrap/container";
import { parseNodeSlug } from "@/features/nodes/node-slug";
import { getServerSessionUser } from "@/lib/auth/server";
import { getGithubRepo } from "@/shared/config";
import { nodes } from "@/shared/db/nodes";
import { SUPPORTED_CHAIN_IDS } from "@/shared/web3";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    return NextResponse.json(
      { error: "slug already taken", reason },
      { status: 409 }
    );
  }

  return NextResponse.json({ node: inserted[0] }, { status: 201 });
}
