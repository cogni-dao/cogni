// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes`
 * Purpose: List + create rows in the operator's externally-registered node registry.
 * Scope: Owner-scoped reads via RLS; writes use a session-derived owner_user_id.
 * Invariants: OWNER_GATING, NODES_TABLE_SCOPE (external only — enforced via repo-url parser).
 * Side-effects: IO (Postgres)
 * Links: task.5083
 * @public
 */

import { withTenantScope } from "@cogni/db-client";
import { type UserId, userActor } from "@cogni/ids";
import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveAppDb } from "@/bootstrap/container";
import { parseRepoUrl } from "@/features/nodes/repo-url";
import { getServerSessionUser } from "@/lib/auth/server";
import { nodes } from "@/shared/db/nodes";
import { SUPPORTED_CHAIN_IDS } from "@/shared/web3";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUPPORTED_CHAIN_ID_LIST: readonly number[] = SUPPORTED_CHAIN_IDS;

const CreateNodeInput = z.object({
  repoUrl: z.string().min(1),
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

  const repo = parseRepoUrl(parsed.data.repoUrl);
  if (!repo.ok) {
    return NextResponse.json(
      { error: "invalid repoUrl", reason: repo.reason },
      { status: 400 }
    );
  }

  const db = resolveAppDb();
  const inserted = await withTenantScope(
    db,
    userActor(session.id as UserId),
    async (tx) =>
      tx
        .insert(nodes)
        .values({
          slug: repo.value.slug,
          repoUrl: repo.value.canonicalUrl,
          repoOwner: repo.value.owner,
          repoName: repo.value.repo,
          repoVisibility: "public",
          ownerUserId: session.id,
          chainId: parsed.data.chainId,
          status: "dao_pending",
        })
        .onConflictDoNothing({ target: nodes.repoUrl })
        .returning()
  );

  if (inserted.length === 0) {
    // Row already exists — return the existing one for idempotency.
    const existing = await withTenantScope(
      db,
      userActor(session.id as UserId),
      async (tx) =>
        tx
          .select()
          .from(nodes)
          .where(eq(nodes.repoUrl, repo.value.canonicalUrl))
          .limit(1)
    );
    if (existing.length === 0) {
      return NextResponse.json(
        { error: "node already exists but is owned by another user" },
        { status: 409 }
      );
    }
    return NextResponse.json({ node: existing[0] }, { status: 200 });
  }

  return NextResponse.json({ node: inserted[0] }, { status: 201 });
}
