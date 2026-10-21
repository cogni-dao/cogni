// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Operator-local, preview-only lifetime fence. Never delete tombstones or paid receipts. */
import { sql } from "drizzle-orm";
import {
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const akashPreviewAdmissions = pgTable(
  "akash_preview_admissions",
  {
    deploymentId: uuid("deployment_id").primaryKey(),
    walletScope: text("wallet_scope").notNull(),
    nodeId: uuid("node_id").notNull(),
    environment: text("environment").notNull(),
    requestKey: text("request_key").notNull(),
    payloadHash: text("payload_hash").notNull(),
    sourceSha: text("source_sha").notNull(),
    artifactRef: text("artifact_ref").notNull(),
    bundleRef: text("bundle_ref").notNull(),
    stateSlot: integer("state_slot").notNull(),
    resetGeneration: uuid("reset_generation"),
    resolvedSdlHash: text("resolved_sdl_hash"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    closureObservedAt: timestamp("closure_observed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("akash_preview_admissions_reset_generation_idx").on(
      t.resetGeneration
    ),
    uniqueIndex("akash_preview_admissions_request_idx").on(
      t.walletScope,
      t.requestKey
    ),
    // Unknown/releasing deployments retain their reusable state pair and admission capacity.
    uniqueIndex("akash_preview_admissions_live_slot_idx")
      .on(t.walletScope, t.stateSlot)
      .where(sql`${t.closureObservedAt} is null`),
    check("akash_preview_admissions_slot_check", sql`${t.stateSlot} in (0, 1)`),
    check(
      "akash_preview_admissions_wallet_check",
      sql`${t.walletScope} ~ '^akash-console:akash1[0-9a-z]{38}$'`
    ),
    check(
      "akash_preview_admissions_sha_check",
      sql`${t.sourceSha} ~ '^[0-9a-f]{40}$' and ${t.payloadHash} ~ '^[0-9a-f]{64}$' and (${t.resolvedSdlHash} is null or ${t.resolvedSdlHash} ~ '^[0-9a-f]{64}$')`
    ),
    check(
      "akash_preview_admissions_artifact_check",
      sql`${t.artifactRef} ~ '@sha256:[0-9a-f]{64}$' and ${t.bundleRef} ~ '@sha256:[0-9a-f]{64}$'`
    ),
    check(
      "akash_preview_admissions_finite_lifetime",
      sql`${t.expiresAt} > ${t.createdAt} and ${t.expiresAt} <= ${t.createdAt} + interval '2 hours'`
    ),
  ]
);
