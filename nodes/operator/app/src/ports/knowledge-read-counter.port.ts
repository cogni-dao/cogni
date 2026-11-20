// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@ports/knowledge-read-counter.port`
 * Purpose: Count one agent atom read without touching the caller's latency or outcome (story.0061).
 * Scope: Interface only. The batched Postgres counter and its flush policy live in @cogni-dao/metrics/usage.
 * Invariants: NEVER_BLOCKS — `count()` returns synchronously and never throws; AGENTS_ONLY — humans are never counted.
 * Side-effects: none (interface only)
 * Links: https://node-template.cognidao.org/knowledge/knowledge-usage-telemetry
 * @public
 */

import type { KnowledgeRead } from "@cogni-dao/metrics/usage";

export type {
  KnowledgeRead,
  KnowledgeReaderClass,
} from "@cogni-dao/metrics/usage";

export interface KnowledgeReadCounter {
  count(read: KnowledgeRead): void;
}
