// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/db-schema/ai-threads`
 * Purpose: Thread persistence schema — stores UIMessage[] per thread for server-authoritative conversation history.
 * Scope: Defines ai_threads table. Does not contain query logic.
 * Invariants:
 *   - UNIQUE(owner_user_id, state_key) — one row per tenant+thread
 *   - RLS on owner_user_id — same pattern as billing_accounts
 *   - messages JSONB stores UIMessage[] — complete conversation history
 *   - SOFT_DELETE_DEFAULT — all reads filter deleted_at IS NULL
 * Side-effects: none (schema definitions only)
 * Links: https://node-template.cognidao.org/knowledge/thread-persistence-contract
 * @public
 */

import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * AI threads table — server-authoritative conversation persistence.
 *
 * Per thread-persistence spec:
 * - messages stores UIMessage[] (AI SDK type) as JSONB
 * - owner_user_id is the authenticated user ID (NOT billing account ID)
 * - state_key is the client-visible thread identifier (validated at route)
 * - RLS enforced via owner_user_id = current_setting('app.current_user_id')
 */
export const aiThreads = pgTable(
  "ai_threads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Authenticated user ID for RLS — same pattern as billing_accounts */
    ownerUserId: text("owner_user_id").notNull(),
    /** Client-visible thread identifier — validated: ^[a-zA-Z0-9_-]{1,128}$ */
    stateKey: text("state_key").notNull(),
    /** UIMessage[] — complete conversation history */
    messages: jsonb("messages").notNull().default(sql`'[]'::jsonb`),
    /** Thread-level metadata (model, graphName, etc.) */
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Soft delete timestamp — per SOFT_DELETE_DEFAULT */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    // One row per tenant+thread (upsert target)
    uniqueIndex("ai_threads_owner_state_key_unique").on(
      table.ownerUserId,
      table.stateKey
    ),
    // Thread list sorted by recency
    index("ai_threads_owner_updated_idx").on(
      table.ownerUserId,
      table.updatedAt
    ),
    // RLS policy — same direct FK pattern as billing_accounts
    pgPolicy("tenant_isolation", {
      using: sql`"owner_user_id" = current_setting('app.current_user_id', true)`,
      withCheck: sql`"owner_user_id" = current_setting('app.current_user_id', true)`,
    }),
  ]
).enableRLS();
