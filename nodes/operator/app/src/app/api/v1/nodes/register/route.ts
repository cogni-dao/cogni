// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/register`
 * Purpose: Register a FIRST-CLASS node (`operator` / `node-template`) as a registry row owned by the
 *   caller — the one path that bypasses the wizard's reserved-slug block so the hub + fork-source can
 *   become RBAC-anchored nodes an agent can be granted on.
 * Scope: Session-gated, idempotent. Inserts identity/ownership only; catalog stays the deploy SSoT.
 *   V0_GATE: any authenticated caller may register one of the fixed first-class slugs (idempotent —
 *   first registrant owns it; re-register is a no-op). Hardening to a governance-approver gate is a
 *   tracked follow-up before this ships to prod.
 * Invariants: AUTH_REQUIRED, FIRST_CLASS_ONLY (slug ∈ FIRST_CLASS_NODES), USER_ROW_ENSURED,
 *   IDEMPOTENT (onConflictDoNothing on slug), NODES_TABLE_SCOPE (identity/ownership/RBAC anchor only).
 * Side-effects: IO (Postgres)
 * Links: story.5009, docs/spec/identity-model.md, src/features/nodes/first-class-nodes.ts
 * @public
 */

import { withTenantScope } from "@cogni/db-client";
import { users } from "@cogni/db-schema/refs";
import { type UserId, userActor } from "@cogni/ids";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveAppDb } from "@/bootstrap/container";
import {
  FIRST_CLASS_NODES,
  isFirstClassSlug,
} from "@/features/nodes/first-class-nodes";
import { getServerSessionUser } from "@/lib/auth/server";
import { nodes } from "@/shared/db/nodes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RegisterInput = z.object({ slug: z.string().min(1) });

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
  const parsed = RegisterInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid input", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const { slug } = parsed.data;
  if (!isFirstClassSlug(slug)) {
    return NextResponse.json(
      {
        error: "not a first-class node",
        reason: `slug must be one of: ${Object.keys(FIRST_CLASS_NODES).join(", ")}`,
      },
      { status: 400 }
    );
  }

  const coords = FIRST_CLASS_NODES[slug];
  const repoUrl = `https://github.com/${coords.repoOwner}/${coords.repoName}`;
  const db = resolveAppDb();

  // USER_ROW_ENSURED: nodes.owner_user_id FKs users.id. Mirror the wizard create path.
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

  const inserted = await withTenantScope(
    db,
    userActor(session.id as UserId),
    async (tx) =>
      tx
        .insert(nodes)
        .values({
          slug,
          repoUrl,
          repoOwner: coords.repoOwner,
          repoName: coords.repoName,
          repoVisibility: "public",
          ownerUserId: session.id,
          status: "active",
        })
        .onConflictDoNothing({ target: nodes.slug })
        .returning()
  );

  if (inserted.length === 0) {
    // IDEMPOTENT: already registered. Return the row if the caller owns it; otherwise report taken.
    const existing = await withTenantScope(
      db,
      userActor(session.id as UserId),
      async (tx) => tx.select().from(nodes).where(eq(nodes.slug, slug)).limit(1)
    );
    if (existing[0]) {
      return NextResponse.json({ node: existing[0], alreadyRegistered: true });
    }
    return NextResponse.json(
      { error: "slug already registered by another owner", slug },
      { status: 409 }
    );
  }

  return NextResponse.json({ node: inserted[0] }, { status: 201 });
}
