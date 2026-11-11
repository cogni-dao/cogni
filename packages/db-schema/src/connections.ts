// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/db-schema/connections`
 * Purpose: Encrypted credential storage for external service connections (BYO-AI, tool auth).
 * Scope: Defines connections table per spec.tenant-connections schema. Does not contain encryption logic or broker queries.
 * Invariants:
 * - ENCRYPTED_AT_REST: Credentials stored as AEAD encrypted JSON blob, never plaintext columns.
 * - TENANT_SCOPED: Connections belong to billing_account_id. Cross-tenant access forbidden.
 * - SOFT_DELETE: Revocation sets revoked_at, never hard-deletes.
 * Side-effects: none (schema definitions only)
 * Links: docs/spec/tenant-connections.md
 * @public
 */

import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { billingAccounts, users } from "./refs";

/** Custom bytea type for encrypted credential blobs */
const bytea = customType<{ data: Buffer; dpiType: string }>({
  dataType() {
    return "bytea";
  },
});

const CONNECTION_PROVIDERS = [
  "openai-chatgpt",
  "openai-compatible",
  "github",
  "google",
  "bluesky",
  "cogni-node",
] as const;

const CREDENTIAL_TYPES = [
  "oauth2",
  "api_key",
  "app_password",
  "github_app_installation",
] as const;

/**
 * Encrypted connections for external services.
 * Per spec.tenant-connections: AEAD encrypted JSON blob with AAD binding
 * {billing_account_id, connection_id, provider[, audience]} — `audience` is bound only when set.
 */
export const connections = pgTable(
  "connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    billingAccountId: text("billing_account_id")
      .notNull()
      .references(() => billingAccounts.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    /**
     * Origin of the service a `cogni-node` key is valid for (`https://<X host>`); null for every other
     * provider. Part of the unique index and of the AEAD bound data (story.0038).
     */
    audience: text("audience"),
    credentialType: text("credential_type").notNull(),
    /** AEAD encrypted JSON blob (nonce prepended). Never store plaintext tokens. */
    encryptedCredentials: bytea("encrypted_credentials").notNull(),
    /** Key ID for rotation — matches env-provided key */
    encryptionKeyId: text("encryption_key_id").notNull(),
    /** OAuth scopes granted (empty array for non-OAuth types) */
    scopes: text("scopes").array().notNull().default(sql`ARRAY[]::text[]`),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: text("revoked_by_user_id").references(() => users.id),
  },
  (table) => [
    check(
      "connections_provider_check",
      sql`${table.provider} IN (${sql.join(
        CONNECTION_PROVIDERS.map((p) => sql`${p}`),
        sql`, `
      )})`
    ),
    check(
      "connections_credential_type_check",
      sql`${table.credentialType} IN (${sql.join(
        CREDENTIAL_TYPES.map((t) => sql`${t}`),
        sql`, `
      )})`
    ),
    index("connections_billing_account_id_idx").on(table.billingAccountId),
    uniqueIndex("connections_billing_account_provider_audience_active_idx")
      .on(
        table.billingAccountId,
        table.provider,
        sql`coalesce(${table.audience}, '')`
      )
      .where(sql`${table.revokedAt} IS NULL`),
  ]
).enableRLS();
