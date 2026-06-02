// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/thread-persistence.port`
 * Purpose: Port interface for server-authoritative thread persistence.
 * Scope: Defines ThreadPersistencePort, ThreadSummary (with title + metadata), and ThreadConflictError. Does not contain implementations.
 * Invariants:
 *   - OPTIMISTIC_APPEND: saveThread() verifies stored message count matches expectedMessageCount before writing
 *   - MAX_THREAD_MESSAGES: saveThread() rejects if messages.length > 200
 *   - SOFT_DELETE_DEFAULT: all reads filter deleted_at IS NULL
 * Side-effects: none
 * Links: docs/spec/thread-persistence.md
 * @public
 */

import type { UIMessage } from "ai";

/** Thrown when saveThread() detects a concurrent modification (stored count != expected). */
export class ThreadConflictError extends Error {
  constructor(stateKey: string) {
    super(
      `Thread conflict for stateKey=${stateKey}: stored message count does not match expected`
    );
    this.name = "ThreadConflictError";
  }
}

/** Summary of a thread for listing (no full message content). */
export interface ThreadSummary {
  stateKey: string;
  /** Auto-derived from first user text part, or metadata.title if set. */
  title?: string | undefined;
  updatedAt: Date;
  messageCount: number;
  metadata?: Record<string, unknown> | undefined;
}

export interface ThreadPersistencePort {
  /** Load thread messages. Returns empty array if thread doesn't exist. */
  loadThread(ownerUserId: string, stateKey: string): Promise<UIMessage[]>;

  /**
   * Persist full message array (upsert). Creates thread if not exists.
   * OPTIMISTIC_APPEND: verifies stored message count matches expectedMessageCount.
   * Throws ThreadConflictError on mismatch — caller should reload and retry once.
   * MAX_THREAD_MESSAGES: rejects if messages.length > 200.
   * metadata is set on INSERT only (first save); subsequent saves ignore it.
   */
  saveThread(
    ownerUserId: string,
    stateKey: string,
    messages: UIMessage[],
    expectedMessageCount: number,
    metadata?: Record<string, unknown>
  ): Promise<void>;

  /** Soft delete thread. Sets deleted_at, messages still in DB for retention. */
  softDelete(ownerUserId: string, stateKey: string): Promise<void>;

  /** List threads for owner, ordered by recency. */
  listThreads(
    ownerUserId: string,
    opts?: { limit?: number; offset?: number }
  ): Promise<ThreadSummary[]>;
}
