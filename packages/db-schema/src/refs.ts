// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/db-schema/refs`
 * Purpose: FK target tables - canonical home for tables referenced across domain slices.
 * Scope: Defines users and billingAccounts tables only. Does not contain domain-specific tables.
 * Invariants:
 * - This is the ROOT of the schema DAG - imports nothing from other slices
 * - All cross-slice FK references point to tables defined here
 * - FORBIDDEN: Importing from scheduling, auth, billing slices (would create cycles)
 * Side-effects: none (schema definitions only)
 * Links: docs/spec/packages-architecture.md
 * @public
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Users table - primary identity table for SIWE authentication.
 * FK target for: billingAccounts, executionGrants, schedules
 */
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name"),
  email: text("email"),
  emailVerified: timestamp("email_verified", { withTimezone: true }),
  image: text("image"),
  walletAddress: text("wallet_address").unique(),
}).enableRLS();

/**
 * Billing accounts table - per-user billing entity.
 * FK target for: executionGrants, virtualKeys, creditLedger, chargeReceipts, paymentAttempts
 */
export const billingAccounts = pgTable(
  "billing_accounts",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),
    isSystemTenant: boolean("is_system_tenant").notNull().default(false),
    slug: text("slug").unique(),
    balanceCredits: bigint("balance_credits", { mode: "bigint" }).notNull(),
    /**
     * Durable completion marker for the one-time OpenFGA owner bootstrap.
     * Null means account creation committed but authorization projection must
     * be resumed. Once set it is never cleared, so a later owner revocation is
     * not silently resurrected by an ordinary account lookup.
     */
    authorizationOwnerBootstrappedAt: timestamp(
      "authorization_owner_bootstrapped_at",
      { withTimezone: true }
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    /** Enforce exactly one system tenant at DB level */
    oneSystemTenant: uniqueIndex("billing_accounts_one_system_tenant")
      .on(table.isSystemTenant)
      .where(sql`${table.isSystemTenant} = true`),
  })
).enableRLS();
