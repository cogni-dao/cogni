// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/auth/openai-compatible/disconnect`
 * Purpose: Disconnect (soft-delete) an OpenAI-compatible endpoint connection.
 * Scope: POST endpoint. Sets revoked_at on the active connection.
 * Invariants:
 *   - SOFT_DELETE: Sets revoked_at, never hard-deletes
 *   - TENANT_SCOPED: Only disconnects connections belonging to the authenticated user
 * Side-effects: IO (DB update)
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
import { makeLogger } from "@/shared/observability";

export const runtime = "nodejs";

const log = makeLogger({ component: "openai-compatible-disconnect" });

export async function POST() {
  const session = await getServerSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const container = getContainer();
  const accountService = container.accountsForUser(session.id as UserId);
  const billingAccount = await getOrCreateBillingAccountForUser(
    accountService,
    { userId: session.id }
  );

  const db = resolveAppDb();
  try {
    await withTenantScope(db, userActor(session.id as UserId), async (tx) =>
      tx
        .update(connections)
        .set({ revokedAt: new Date(), revokedByUserId: session.id })
        .where(
          and(
            eq(connections.billingAccountId, billingAccount.id),
            eq(connections.provider, "openai-compatible"),
            isNull(connections.revokedAt)
          )
        )
    );

    log.info(
      { billingAccountId: billingAccount.id },
      "OpenAI-compatible endpoint disconnected"
    );
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : String(err) },
      "Failed to disconnect"
    );
    return NextResponse.json(
      { error: "Failed to disconnect" },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
