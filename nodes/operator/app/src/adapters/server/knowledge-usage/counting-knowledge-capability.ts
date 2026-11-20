// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/knowledge-usage/counting-knowledge-capability`
 * Purpose: Count every internal-run atom read made through the in-process KnowledgeCapability (story.0061).
 * Scope: Wraps `get` only; every other method passes through unchanged. Covers core__knowledge_read by id
 *   without parsing tool output.
 * Invariants:
 * - RUNS_ONLY: a call outside an execution scope is not a run, so it is not counted.
 * - RESULT_UNCHANGED: the decorator returns exactly what the inner capability returned, and rethrows its errors uncounted.
 * Side-effects: none beyond `counter.count()`
 * Links: https://node-template.cognidao.org/knowledge/knowledge-usage-telemetry
 * @internal
 */

import type { KnowledgeCapability } from "@cogni/shared-ai-tools";

import type { KnowledgeReadCounter } from "@/ports";

/** Principal id for an internal run whose scope carries no acting principal. */
export const UNSCOPED_RUN_PRINCIPAL = "internal_run:unscoped";

export function withReadCounting(
  inner: KnowledgeCapability,
  counter: KnowledgeReadCounter,
  /** The acting principal of the current run, or `undefined` when no run is in scope. */
  currentRun: () => { principalId: string | undefined } | undefined
): KnowledgeCapability {
  return {
    ...inner,
    async get(id: string) {
      const entry = await inner.get(id);
      const run = currentRun();
      if (run) {
        counter.count({
          atomId: id,
          outcome: entry ? "ok" : "fail",
          principalId: run.principalId ?? UNSCOPED_RUN_PRINCIPAL,
          principalClass: "internal_run",
        });
      }
      return entry;
    },
  };
}
