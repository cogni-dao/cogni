// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/identity/create-binding`
 * Purpose: Creates a user binding + identity event in a single transaction.
 * Scope: INSERT into user_bindings + identity_events. Does not handle auth flows or session management.
 * Invariants:
 * - BINDINGS_ARE_EVIDENCED: Every binding INSERT is paired with an identity_events INSERT (proof in payload).
 * - NO_AUTO_MERGE: ON CONFLICT(provider, external_id) DO NOTHING — idempotent, never re-points.
 * - APPEND_ONLY_EVENTS: identity_events is append-only (DB trigger enforced).
 * Side-effects: IO (database writes)
 * Links: docs/spec/decentralized-identity.md
 * @public
 */

import { randomUUID } from "node:crypto";

import type { Database } from "@cogni/db-client";

import { identityEvents, userBindings } from "@/shared/db/schema";

/**
 * Creates a user binding and records a corresponding identity event.
 * Idempotent: if the (provider, external_id) pair already exists, both INSERTs are skipped.
 *
 * @param db - Drizzle database instance (service-role for auth callbacks)
 * @param userId - The user's canonical UUID (users.id)
 * @param provider - Binding provider: 'wallet' | 'discord' | 'github' | 'google'
 * @param externalId - Provider-specific identifier (address, snowflake, numeric ID)
 * @param payload - Evidence payload stored in identity_events (e.g. { method: 'siwe', ... })
 */
export async function createBinding(
  db: Database,
  userId: string,
  provider: "wallet" | "discord" | "github" | "google",
  externalId: string,
  payload: Record<string, unknown>
): Promise<void> {
  const bindingId = randomUUID();
  const eventId = randomUUID();

  // Single transaction: binding INSERT + identity_event INSERT.
  // If the binding already exists (idempotent case), skip both.
  await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(userBindings)
      .values({
        id: bindingId,
        userId,
        provider,
        externalId,
      })
      .onConflictDoNothing({
        target: [userBindings.provider, userBindings.externalId],
      })
      .returning({ id: userBindings.id });

    // Only record the event if a new binding was actually created
    if (inserted) {
      await tx.insert(identityEvents).values({
        id: eventId,
        userId,
        eventType: "bind",
        payload: { provider, external_id: externalId, ...payload },
      });
    }
  });
}
