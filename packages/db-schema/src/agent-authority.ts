// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/db-schema/agent-authority`
 * Purpose: Runtime agent authority tables: internal agent principals and node role rows.
 * Scope: Schema only. Reads and writes live in `@cogni-dao/agent-grants` (raw SQL over an injected client). Does not contain queries or business logic.
 * Invariants:
 *   - AGENTS_HOLD_NO_WALLET: an internal principal row points at a seeded `users` row with no wallet and has no credential.
 *   - CREDENTIALS_ONLY_ON_AGENT_PRINCIPALS: `agent_credentials` rows belong only to a user with an `external` `agent_principals` row
 *     (a trigger in the migration enforces it).
 *   - ROLE_ROWS_ARE_SOFT_REVOKED: a role row is never deleted; `revoked_at` ends it. One live row per (principal, scope).
 *   - NO_ACCOUNT_GRANTS: account scopes are out of scope; no account-grant table ships.
 *   - TOKEN_HASH_ONLY / STATE_IS_DERIVED: `agent_credentials` stores sha256 of the key and timestamps only; state (pending, active,
 *     renew_only, expired, revoked) is derived by the SQL function `agent_credential_state` (migration), never stored.
 *   - SERVICE_ROLE_ONLY_WRITES: `agent_credentials` and `agent_roles` have ENABLE + FORCE RLS and no policy (deny-all for the app role).
 *     `agent_principals` is readable by every role (its select policy) and writable only by a BYPASSRLS service
 *     connection. FORCE is added by hand in the migration.
 *   - AGENTS_HOLD_NO_WALLET (a payout guard, enforced in the database; it does not decide who may be admin): a trigger on `user_bindings` (migration) refuses a wallet
 *     binding for any user that has an `agent_principals` row, on every binding path.
 * Side-effects: none (schema definitions only)
 * Links: https://cognidao.org/knowledge/node-capability-grants-standard
 * @public
 */

import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./refs";

/** A marked agent. `internal` rows are seeded for a graph to act as; `external` rows come from redeemed spawn grants (later). */
export const agentPrincipals = pgTable(
  "agent_principals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    slug: text("slug"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "agent_principals_kind_canonical",
      sql`${table.kind} IN ('internal','external')`
    ),
    check(
      "agent_principals_internal_has_slug",
      sql`${table.kind} <> 'internal' OR ${table.slug} IS NOT NULL`
    ),
    uniqueIndex("agent_principals_slug_unique").on(table.slug),
    uniqueIndex("agent_principals_user_id_unique").on(table.userId),
    // Read-only for every role: slug and seeded user id are not secret, and the wallet-binding trigger must see
    // them whichever role binds. Writes stay deny-all for the app role (no write policy; FORCE RLS).
    pgPolicy("agent_principals_read", { for: "select", using: sql`true` }),
  ]
).enableRLS();

/**
 * One grant row: a permission (scope) for an agent principal.
 * Pending = `approved_by IS NULL` and not revoked (the agent asked; no admin has said yes). Live = approved and not revoked.
 * Denied = never approved, revoked. Revoked = approved, then revoked. Only a live row opens a lock.
 */
export const agentRoles = pgTable(
  "agent_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    principalUserId: text("principal_user_id")
      .notNull()
      .references(() => users.id),
    scope: text("scope").notNull(),
    approvedBy: text("approved_by").references(() => users.id),
    /** Set when an admin approves. Null while pending or denied. */
    grantedAt: timestamp("granted_at", { withTimezone: true }),
    /** The agent that asked, for a row that began as a request. Null for a row an admin wrote directly. */
    requestedBy: text("requested_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("agent_roles_live_unique")
      .on(table.principalUserId, table.scope)
      .where(sql`${table.revokedAt} IS NULL`),
    index("agent_roles_principal_idx").on(table.principalUserId),
  ]
).enableRLS();

/**
 * One revocable agent key (v2). `token_hash` is sha256 of the key; the key is never stored.
 * pending = `confirmed_at IS NULL` inside `pending_expires_at`. A rotation inserts a pending successor (`predecessor_id`); confirm
 * activates it and revokes the predecessor in one transaction. Revoking a row ends only that key.
 */
export const agentCredentials = pgTable(
  "agent_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: text("token_hash").notNull(),
    createdFrom: text("created_from").notNull(),
    predecessorId: uuid("predecessor_id"),
    issuedAt: timestamp("issued_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    renewUntil: timestamp("renew_until", { withTimezone: true }).notNull(),
    pendingExpiresAt: timestamp("pending_expires_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
    revokedBy: text("revoked_by"),
  },
  (table) => [
    foreignKey({
      columns: [table.predecessorId],
      foreignColumns: [table.id],
      name: "agent_credentials_predecessor_id_fk",
    }),
    check(
      "agent_credentials_created_from_canonical",
      sql`${table.createdFrom} IN ('spawn_grant','rotation','legacy_upgrade','binding_recovery','recovery_grant')`
    ),
    check(
      "agent_credentials_renew_after_expiry",
      sql`${table.renewUntil} > ${table.expiresAt}`
    ),
    uniqueIndex("agent_credentials_token_hash_unique").on(table.tokenHash),
    // One pending successor per predecessor: a second rotate supersedes (revokes) the first before it inserts.
    uniqueIndex("agent_credentials_one_pending_successor")
      .on(table.predecessorId)
      .where(sql`${table.confirmedAt} IS NULL AND ${table.revokedAt} IS NULL`),
    // Not partial: the v1 gate (`everConfirmed`) reads revoked rows too, on every v1-authenticated request.
    index("agent_credentials_user_idx").on(table.userId),
  ]
).enableRLS();
