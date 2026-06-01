// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/db/transcript-ingest`
 * Purpose: Drizzle adapter for the raw AI-developer transcript firehose.
 *   Persistence only — append a chunk, de-duplicating on (sessionId, cursor).
 * Scope: Does not redact, authorize, or distill. Redaction happens client-side
 *   in the hook; auth happens at the route; synthesis is a downstream harvester.
 * Invariants: IDEMPOTENT_BY_SESSION_CURSOR (conflict on the unique index is a
 *   no-op de-dup), RAW_NEVER_ENTERS_HUB.
 * Side-effects: IO (Postgres via injected Drizzle service database).
 * Links: docs/design/agent-transcript-telemetry.md
 * @internal
 */

import type { Database } from "@cogni/db-client";
import { and, eq } from "drizzle-orm";

import type {
  TranscriptAppendResult,
  TranscriptChunkInput,
  TranscriptIngestPort,
} from "@/ports";
import { agentTranscriptChunks } from "@/shared/db/agent-transcripts";

export class DrizzleTranscriptIngestAdapter implements TranscriptIngestPort {
  constructor(private readonly db: Database) {}

  async append(input: TranscriptChunkInput): Promise<TranscriptAppendResult> {
    const [inserted] = await this.db
      .insert(agentTranscriptChunks)
      .values({
        principalId: input.principalId,
        principalName: input.principalName,
        sessionId: input.sessionId,
        cursor: input.cursor,
        repo: input.repo,
        node: input.node,
        headSha: input.headSha,
        branch: input.branch,
        cwd: input.cwd,
        transcriptPath: input.transcriptPath,
        body: input.body,
        byteLen: input.byteLen,
      })
      .onConflictDoNothing({
        target: [agentTranscriptChunks.sessionId, agentTranscriptChunks.cursor],
      })
      .returning({ id: agentTranscriptChunks.id });

    if (inserted) return { id: inserted.id, deduped: false };

    const [existing] = await this.db
      .select({ id: agentTranscriptChunks.id })
      .from(agentTranscriptChunks)
      .where(
        and(
          eq(agentTranscriptChunks.sessionId, input.sessionId),
          eq(agentTranscriptChunks.cursor, input.cursor)
        )
      )
      .limit(1);

    return { id: existing?.id ?? "", deduped: true };
  }
}
