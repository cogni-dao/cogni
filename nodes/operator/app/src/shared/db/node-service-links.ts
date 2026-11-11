// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/db/node-service-links`
 * Purpose: One row per operator service link to a node X (story.0038 T2): the enrollment state the
 *   operator's `git-review` service holds while X's DAO admin clicks On, then the pointer to the
 *   `connections` row that holds the X-issued key.
 * Scope: Operator-local table. Service-role only (ENABLE + FORCE RLS, no policy; the FORCE statement is
 *   hand-appended to the generated migration). Holds no plaintext secret: the poll device code and the
 *   ephemeral X25519 private key are AEAD-encrypted under CONNECTIONS_ENCRYPTION_KEY and nulled when
 *   the link connects.
 * Invariants:
 *   - ONE_OPEN_LINK_PER_NODE_SERVICE: a partial unique index allows one `pending` or `connected` row per
 *     (node_id, service).
 *   - JTI_ONCE: `jti` is unique; the enrollment token the operator signed for this row carries it.
 *   - NO_PLAINTEXT_SECRET: `device_code_enc` and `cnf_private_key_enc` are AEAD blobs, never plaintext.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/node-service-enrollment, story.0038
 * @public
 */

import { users } from "@cogni/db-schema/refs";
import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { nodes } from "./nodes";

const bytea = customType<{ data: Buffer; dpiType: string }>({
  dataType() {
    return "bytea";
  },
});

/** Services an operator link may enroll (v0: the review agent). */
export const NODE_SERVICE_LINK_SERVICES = ["git-review"] as const;
export type NodeServiceLinkService =
  (typeof NODE_SERVICE_LINK_SERVICES)[number];

export const NODE_SERVICE_LINK_STATES = [
  "pending",
  "connected",
  "needs_reenroll",
  "failed",
  "superseded",
] as const;
export type NodeServiceLinkState = (typeof NODE_SERVICE_LINK_STATES)[number];

/** SQL literal list for a CHECK (drizzle would otherwise emit `$n` placeholders into DDL). */
const quoted = (values: readonly string[]): string =>
  values.map((v) => `'${v}'`).join(", ");

export const nodeServiceLinks = pgTable(
  "node_service_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    service: text("service").notNull(),
    /** Registered origin of X (`https://<host>`), resolved from the node registry, never the body. */
    audience: text("audience").notNull(),
    state: text("state").notNull().default("pending"),
    requestedByUserId: text("requested_by_user_id")
      .notNull()
      .references(() => users.id),
    /** `jti` of the signed `service.enrollment.v1` token for this link. */
    jti: uuid("jti").notNull(),
    /** AEAD blob of X's `deviceCode`; null once the link leaves `pending`. */
    deviceCodeEnc: bytea("device_code_enc"),
    /** AEAD blob of the ephemeral X25519 private JWK the key is sealed to; null once connected. */
    cnfPrivateKeyEnc: bytea("cnf_private_key_enc"),
    encryptionKeyId: text("encryption_key_id").notNull(),
    pollIntervalS: integer("poll_interval_s").notNull().default(5),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    deviceCodeExpiresAt: timestamp("device_code_expires_at", {
      withTimezone: true,
    }).notNull(),
    /** The operator `connections` row holding the X-issued key (set on `connected`). */
    connectionId: uuid("connection_id"),
    failureCode: text("failure_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "node_service_links_service_check",
      sql`${table.service} IN (${sql.raw(quoted(NODE_SERVICE_LINK_SERVICES))})`
    ),
    check(
      "node_service_links_state_check",
      sql`${table.state} IN (${sql.raw(quoted(NODE_SERVICE_LINK_STATES))})`
    ),
    uniqueIndex("node_service_links_jti_idx").on(table.jti),
    uniqueIndex("node_service_links_open_idx")
      .on(table.nodeId, table.service)
      .where(sql`${table.state} IN ('pending', 'connected')`),
    index("node_service_links_node_idx").on(table.nodeId),
  ]
).enableRLS();
