// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/transcript-ingest`
 * Purpose: Port for appending raw AI-developer session transcript chunks to
 *   the operator-local firehose. Interface + DTO only.
 * Scope: Persistence need. Does not own HTTP translation, redaction, or the
 *   downstream knowledge-synthesis ("harvester") step.
 * Invariants: PORTS_DEFINE_NEEDS, IDEMPOTENT_BY_SESSION_CURSOR (re-uploading
 *   the same (sessionId, cursor) is a no-op de-dup, not a duplicate row).
 * Side-effects: none
 * Links: docs/design/agent-transcript-telemetry.md
 * @public
 */

export type TranscriptChunkInput = {
  readonly principalId: string;
  readonly principalName: string | null;
  readonly sessionId: string;
  readonly cursor: number;
  readonly repo: string | null;
  readonly node: string | null;
  readonly headSha: string | null;
  readonly branch: string | null;
  readonly cwd: string | null;
  readonly transcriptPath: string | null;
  readonly body: string;
  readonly byteLen: number;
};

export type TranscriptAppendResult = {
  readonly id: string;
  readonly deduped: boolean;
};

export interface TranscriptIngestPort {
  append(input: TranscriptChunkInput): Promise<TranscriptAppendResult>;
}
