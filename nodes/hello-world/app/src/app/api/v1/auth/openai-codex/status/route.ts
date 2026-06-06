// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/auth/openai-codex/status`
 * Purpose: Check if the authenticated user has an active ChatGPT BYO-AI connection.
 * Scope: GET endpoint. Returns { connected: boolean }. No tokens exposed.
 * Invariants:
 *   - TOKENS_NEVER_LOGGED: Only returns boolean, never credential data
 * Side-effects: IO (DB query)
 * Links: docs/spec/tenant-connections.md
 * @public
 */

import { withTenantScope } from "@cogni/db-client";
import { connections } from "@cogni/db-schema";
import { type UserId, userActor } from "@cogni/ids";
import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";

import { getContainer, resolveAppDb } from "@/bootstrap/container";
import { getOrCreateBillingAccountForUser } from "@/lib/auth/mapping";
import { getServerSessionUser } from "@/lib/auth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSessionUser();
  if (!session) {
    return NextResponse.json({ connected: false });
  }

  try {
    const container = getContainer();
    const accountService = container.accountsForUser(session.id as UserId);
    const billingAccount = await getOrCreateBillingAccountForUser(
      accountService,
      { userId: session.id }
    );

    const db = resolveAppDb();
    const rows = await withTenantScope(
      db,
      userActor(session.id as UserId),
      async (tx) =>
        tx
          .select({ id: connections.id })
          .from(connections)
          .where(
            and(
              eq(connections.billingAccountId, billingAccount.id),
              eq(connections.provider, "openai-chatgpt"),
              isNull(connections.revokedAt)
            )
          )
          .limit(1)
    );

    return NextResponse.json({
      connected: rows.length > 0,
      ...(rows[0] ? { connectionId: rows[0].id } : {}),
    });
  } catch {
    return NextResponse.json({ connected: false });
  }
}
