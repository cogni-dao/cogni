// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/db-schema/identity`
 * Purpose: User identity binding tables — links external accounts (wallet, Discord, GitHub, Google) to users.
 * Scope: Defines the canonical actor identity registry, explicit beneficiary policy,
 * and the legacy user-binding compatibility projection. Does not contain queries or business logic.
 * Invariants:
 * - BINDINGS_ARE_EVIDENCED: Proof lives in identity_events.payload, not on the binding row.
 * - NO_AUTO_MERGE: UNIQUE(provider, external_id) — same external ID for same provider can't bind to two users.
 * - APPEND_ONLY_EVENTS: identity_events rows are append-only; DB trigger rejects UPDATE/DELETE.
 * - USER_ID_AT_CREATION: All FKs reference users.id (UUID).
 * - RLS_ENABLED: Both tables have row-level security enabled.
 * Side-effects: none (schema definitions only)
 * Links: docs/spec/decentralized-identity.md
 * @public
 */

import type { InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { billingAccounts, users } from "./refs";

export const ACTOR_KINDS = ["user", "agent", "system", "org"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export const ACTOR_STATUSES = ["active", "suspended"] as const;
export type ActorStatus = (typeof ACTOR_STATUSES)[number];

/** Durable economic and authorization subjects. Credentials never identify actors. */
export const actors = pgTable(
  "actors",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<ActorKind>().notNull(),
    displayName: text("display_name"),
    userId: text("user_id").references(() => users.id),
    legacyUserId: text("legacy_user_id").references(() => users.id),
    billingAccountId: text("billing_account_id")
      .notNull()
      .references(() => billingAccounts.id),
    spawnedByActorId: text("spawned_by_actor_id").references(
      (): AnyPgColumn => actors.id
    ),
    parentActorId: text("parent_actor_id").references(
      (): AnyPgColumn => actors.id
    ),
    status: text("status").$type<ActorStatus>().notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "actors_kind_check",
      sql`${table.kind} IN ('user', 'agent', 'system', 'org')`
    ),
    check(
      "actors_status_check",
      sql`${table.status} IN ('active', 'suspended')`
    ),
    check(
      "actors_user_shape_check",
      sql`(${table.kind} = 'user' AND ${table.userId} IS NOT NULL) OR (${table.kind} <> 'user' AND ${table.userId} IS NULL)`
    ),
    uniqueIndex("actors_user_id_unique")
      .on(table.userId)
      .where(sql`${table.userId} IS NOT NULL`),
    uniqueIndex("actors_legacy_user_id_unique")
      .on(table.legacyUserId)
      .where(sql`${table.legacyUserId} IS NOT NULL`),
    index("actors_billing_account_id_idx").on(table.billingAccountId),
    index("actors_parent_actor_id_idx").on(table.parentActorId),
  ]
).enableRLS();

/** Append-only evidence for accepted stewardship projection changes. */
export const actorStewardshipEvents = pgTable(
  "actor_stewardship_events",
  {
    id: text("id").primaryKey(),
    actorId: text("actor_id")
      .notNull()
      .references(() => actors.id),
    parentActorId: text("parent_actor_id").references(() => actors.id),
    eventType: text("event_type").notNull(),
    authorizedByActorId: text("authorized_by_actor_id")
      .notNull()
      .references(() => actors.id),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "actor_stewardship_events_type_check",
      sql`${table.eventType} IN ('accepted', 'revoked', 'reassigned')`
    ),
    index("actor_stewardship_events_actor_id_idx").on(table.actorId),
  ]
).enableRLS();

export const ACTOR_BINDING_EVENT_TYPES = [
  "bound",
  "transferred_out",
  "transferred_in",
  "revoked",
] as const;

/**
 * Append-only evidence for canonical external-identity ownership changes.
 * Credentials, mutable provider logins, and legacy user projections are never
 * ownership authority.
 */
export const actorBindingEvents = pgTable(
  "actor_binding_events",
  {
    id: text("id").primaryKey(),
    actorId: text("actor_id")
      .notNull()
      .references(() => actors.id),
    previousActorId: text("previous_actor_id").references(() => actors.id),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    providerLogin: text("provider_login"),
    eventType: text("event_type").notNull(),
    authorizedByActorId: text("authorized_by_actor_id")
      .notNull()
      .references(() => actors.id),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "actor_binding_events_type_check",
      sql`${table.eventType} IN ('bound', 'transferred_out', 'transferred_in', 'revoked')`
    ),
    index("actor_binding_events_source_idx").on(
      table.provider,
      table.externalId,
      table.effectiveAt
    ),
    index("actor_binding_events_actor_id_idx").on(table.actorId),
  ]
).enableRLS();

/**
 * The one current-owner registry for external identities across human and AI
 * actors. Historical ownership lives in actor_binding_events; a transfer closes
 * the old row and opens a new one atomically.
 */
export const actorBindings = pgTable(
  "actor_bindings",
  {
    id: text("id").primaryKey(),
    actorId: text("actor_id")
      .notNull()
      .references(() => actors.id),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    providerLogin: text("provider_login"),
    evidenceEventId: text("evidence_event_id")
      .notNull()
      .references(() => actorBindingEvents.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("actor_bindings_active_source_unique")
      .on(table.provider, table.externalId)
      .where(sql`${table.closedAt} IS NULL`),
    index("actor_bindings_actor_id_idx").on(table.actorId),
  ]
).enableRLS();

/**
 * Effective-dated, explicitly authorized beneficiary selection. Stewardship is
 * stored separately and never supplies an implicit beneficiary default.
 */
export const actorBeneficiaryPolicies = pgTable(
  "actor_beneficiary_policies",
  {
    id: text("id").primaryKey(),
    earnedByActorId: text("earned_by_actor_id")
      .notNull()
      .references(() => actors.id),
    beneficiaryActorId: text("beneficiary_actor_id")
      .notNull()
      .references(() => actors.id),
    policyVersion: text("policy_version").notNull(),
    authorizedByActorId: text("authorized_by_actor_id")
      .notNull()
      .references(() => actors.id),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "actor_beneficiary_policies_window_check",
      sql`${table.effectiveTo} IS NULL OR ${table.effectiveTo} > ${table.effectiveFrom}`
    ),
    uniqueIndex("actor_beneficiary_policies_version_unique").on(
      table.earnedByActorId,
      table.policyVersion
    ),
    uniqueIndex("actor_beneficiary_policies_effective_from_unique").on(
      table.earnedByActorId,
      table.effectiveFrom
    ),
    index("actor_beneficiary_policies_effective_idx").on(
      table.earnedByActorId,
      table.effectiveFrom,
      table.effectiveTo
    ),
  ]
).enableRLS();

export const AGENT_GRANT_STATUSES = ["pending", "redeemed", "revoked"] as const;

/** One-use, hash-only grant that is the only unauthenticated agent spawn seam. */
export const agentSpawnGrants = pgTable(
  "agent_spawn_grants",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    nodeId: text("node_id").notNull(),
    issuerActorId: text("issuer_actor_id")
      .notNull()
      .references(() => actors.id),
    acceptedParentActorId: text("accepted_parent_actor_id").references(
      () => actors.id
    ),
    billingAccountId: text("billing_account_id")
      .notNull()
      .references(() => billingAccounts.id),
    agentName: text("agent_name").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    redeemedActorId: text("redeemed_actor_id").references(() => actors.id),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "agent_spawn_grants_status_check",
      sql`${table.status} IN ('pending', 'redeemed', 'revoked')`
    ),
    uniqueIndex("agent_spawn_grants_issuer_idempotency_unique").on(
      table.issuerActorId,
      table.idempotencyKey
    ),
    index("agent_spawn_grants_issuer_status_idx").on(
      table.issuerActorId,
      table.status
    ),
    index("agent_spawn_grants_billing_status_idx").on(
      table.billingAccountId,
      table.status
    ),
  ]
).enableRLS();

export const AGENT_CREDENTIAL_STATUSES = [
  "pending",
  "active",
  "revoked",
] as const;
export type AgentCredentialStatus = (typeof AGENT_CREDENTIAL_STATUSES)[number];

/** Node-local, hash-only agent bearers. The stable principal is actors.id. */
export const agentCredentials = pgTable(
  "agent_credentials",
  {
    id: text("id").primaryKey(),
    actorId: text("actor_id")
      .notNull()
      .references(() => actors.id),
    nodeId: text("node_id").notNull(),
    secretHash: text("secret_hash").notNull().unique(),
    status: text("status")
      .$type<AgentCredentialStatus>()
      .notNull()
      .default("pending"),
    predecessorCredentialId: text("predecessor_credential_id").references(
      (): AnyPgColumn => agentCredentials.id
    ),
    rotationIdempotencyKey: text("rotation_idempotency_key"),
    replacedByCredentialId: text("replaced_by_credential_id").references(
      (): AnyPgColumn => agentCredentials.id
    ),
    issuedAt: timestamp("issued_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    authenticateUntil: timestamp("authenticate_until", {
      withTimezone: true,
    }).notNull(),
    renewUntil: timestamp("renew_until", { withTimezone: true }).notNull(),
    pendingExpiresAt: timestamp("pending_expires_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "agent_credentials_status_check",
      sql`${table.status} IN ('pending', 'active', 'revoked')`
    ),
    check(
      "agent_credentials_windows_check",
      sql`${table.renewUntil} > ${table.authenticateUntil}`
    ),
    uniqueIndex("agent_credentials_pending_predecessor_unique")
      .on(table.predecessorCredentialId)
      .where(sql`${table.status} = 'pending'`),
    index("agent_credentials_actor_status_idx").on(table.actorId, table.status),
    index("agent_credentials_node_status_idx").on(table.nodeId, table.status),
  ]
).enableRLS();

/** Human/steward-authorized, one-use recovery onto an existing actor. */
export const agentRecoveryGrants = pgTable(
  "agent_recovery_grants",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    nodeId: text("node_id").notNull(),
    actorId: text("actor_id")
      .notNull()
      .references(() => actors.id),
    issuerActorId: text("issuer_actor_id")
      .notNull()
      .references(() => actors.id),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    redeemedCredentialId: text("redeemed_credential_id").references(
      () => agentCredentials.id
    ),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "agent_recovery_grants_status_check",
      sql`${table.status} IN ('pending', 'redeemed', 'revoked')`
    ),
    uniqueIndex("agent_recovery_grants_issuer_idempotency_unique").on(
      table.issuerActorId,
      table.idempotencyKey
    ),
    index("agent_recovery_grants_actor_status_idx").on(
      table.actorId,
      table.status
    ),
  ]
).enableRLS();

/**
 * User bindings — current-state index linking external accounts to users.
 * Proof/evidence lives in identity_events.payload, not here.
 * UNIQUE(provider, external_id) enforces NO_AUTO_MERGE at the DB level.
 */
export const userBindings = pgTable(
  "user_bindings",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    providerLogin: text("provider_login"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "user_bindings_provider_check",
      sql`${table.provider} IN ('wallet', 'discord', 'github', 'google')`
    ),
    uniqueIndex("user_bindings_provider_external_id_unique").on(
      table.provider,
      table.externalId
    ),
    index("user_bindings_user_id_idx").on(table.userId),
  ]
).enableRLS();

/**
 * Link transactions — server-side records for fail-closed account linking.
 * Created when a user initiates an OAuth link, consumed atomically in the
 * NextAuth callback. If consumption fails (expired, already consumed, tampered),
 * the link is rejected — never silently falls through to new-user creation.
 */
export const linkTransactions = pgTable(
  "link_transactions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    provider: text("provider").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "link_transactions_provider_check",
      sql`${table.provider} IN ('github', 'discord', 'google')`
    ),
    index("link_transactions_user_id_idx").on(table.userId),
    pgPolicy("tenant_isolation", {
      using: sql`${table.userId} = current_setting('app.current_user_id', true)`,
      withCheck: sql`${table.userId} = current_setting('app.current_user_id', true)`,
    }),
  ]
).enableRLS();

export type LinkTransaction = InferSelectModel<typeof linkTransactions>;

/**
 * Identity events — append-only audit trail for binding lifecycle.
 * DB trigger rejects UPDATE/DELETE (APPEND_ONLY_EVENTS).
 * Revocation creates a new event, never deletes rows.
 */
export const identityEvents = pgTable(
  "identity_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "identity_events_event_type_check",
      sql`${table.eventType} IN ('bind', 'revoke', 'merge')`
    ),
    index("identity_events_user_id_idx").on(table.userId),
  ]
).enableRLS();
