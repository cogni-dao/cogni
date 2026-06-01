// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/db/agent-transcripts`
 * Purpose: Operator-local Drizzle schema for the raw AI-developer transcript
 *   firehose — one append-only row per uploaded Claude Code session chunk.
 *   Raw operational feedstock, NOT knowledge: a future harvester distills
 *   durable takeaways into the Dolt knowledge hub; rows here are disposable
 *   (TTL-eligible once `harvested_at` is set).
 * Scope: Persistence shape only. Identity (`principal_id`) is the registered
 *   contributor; lineage to the knowledge atom is preserved via source_ref,
 *   never FK'd across databases.
 * Invariants: RAW_NEVER_ENTERS_HUB (this table is the raw plane; the Dolt hub
 *   is the refined plane), ATTRIBUTION_TRACEABLE (`principal_id` notNull).
 * Side-effects: none
 * Links: docs/design/agent-transcript-telemetry.md
 * @public
 */

import { users } from "@cogni/db-schema/refs";
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const agentTranscriptChunks = pgTable(
  "agent_transcript_chunks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    principalId: text("principal_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    principalName: text("principal_name"),
    sessionId: text("session_id").notNull(),
    cursor: integer("cursor").notNull().default(0),
    repo: text("repo"),
    node: text("node"),
    headSha: text("head_sha"),
    branch: text("branch"),
    cwd: text("cwd"),
    transcriptPath: text("transcript_path"),
    body: text("body").notNull(),
    byteLen: integer("byte_len").notNull().default(0),
    prNumber: integer("pr_number"),
    harvestedAt: timestamp("harvested_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("agent_transcript_chunks_session_cursor_idx").on(
      table.sessionId,
      table.cursor
    ),
    index("agent_transcript_chunks_principal_idx").on(table.principalId),
    index("agent_transcript_chunks_session_idx").on(table.sessionId),
    index("agent_transcript_chunks_head_sha_idx").on(table.headSha),
    index("agent_transcript_chunks_unharvested_idx")
      .on(table.createdAt)
      .where(sql`${table.harvestedAt} IS NULL`),
  ]
).enableRLS();
