// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/temporal-workflows/workflows/stages/collect-sources`
 * Purpose: Child workflow for source collection — the triple-nested collection loop (sources × sourceRefs × streams).
 * Scope: Deterministic orchestration only. Does not perform I/O — all external calls happen in Activities.
 * Invariants:
 *   - Per TEMPORAL_DETERMINISM: No I/O — only proxyActivities calls and deterministic logic
 *   - Per STAGE_IO_COLOCATED: Input type defined here, not in a separate barrel
 *   - Per ACTIVITY_IDEMPOTENT: Existing activity idempotency guarantees preserved
 * Side-effects: none (deterministic orchestration only)
 * Links: docs/spec/attribution-ledger.md, docs/spec/temporal-patterns.md
 * @public
 */

import { proxyActivities } from "@temporalio/workflow";
import {
  EXTERNAL_API_ACTIVITY_OPTIONS,
  STANDARD_ACTIVITY_OPTIONS,
} from "../../activity-profiles.js";
import type { LedgerActivities } from "../../activity-types.js";

const { loadCursor, saveCursor, insertReceipts, resolveStreams } =
  proxyActivities<LedgerActivities>(STANDARD_ACTIVITY_OPTIONS);

// collectFromSource may hit GitHub API pagination — use external API profile (5-min timeout).
const { collectFromSource } = proxyActivities<LedgerActivities>(
  EXTERNAL_API_ACTIVITY_OPTIONS
);

/** Input for CollectSourcesWorkflow — plain serializable object. */
export interface CollectSourcesInput {
  readonly epochId: string;
  readonly sources: Record<
    string,
    { attributionPipeline: string; sourceRefs: string[] }
  >;
  readonly periodStart: string;
  readonly periodEnd: string;
}

/**
 * CollectSourcesWorkflow — collects from all sources × sourceRefs × streams.
 *
 * For each source, resolves streams from adapter, then per sourceRef/stream:
 * load cursor → collect → insert receipts → save cursor.
 *
 * This is the longest-running stage and benefits most from independent retry/visibility.
 */
export async function CollectSourcesWorkflow(
  input: CollectSourcesInput
): Promise<void> {
  for (const [source, sourceConfig] of Object.entries(input.sources)) {
    const { streams } = await resolveStreams({ source });
    for (const sourceRef of sourceConfig.sourceRefs) {
      for (const stream of streams) {
        const cursorValue = await loadCursor({ source, stream, sourceRef });
        const result = await collectFromSource({
          source,
          streams: [stream],
          cursorValue,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
        });
        if (result.events.length > 0) {
          await insertReceipts({
            events: result.events,
            producerVersion: result.producerVersion,
          });
        }
        await saveCursor({
          source,
          stream,
          sourceRef,
          cursorValue: result.nextCursorValue,
        });
      }
    }
  }
}
