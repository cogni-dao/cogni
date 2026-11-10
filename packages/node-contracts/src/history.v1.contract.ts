// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/history.v1.contract`
 * Purpose: Read the versions of one work item or knowledge entry, each with its change reason (task.0052).
 * Scope: Re-exports the history schemas that `@cogni-dao/work-items` and `@cogni/shared-knowledge-store/contracts` own (story.0023). Does not define a schema or hold logic of its own.
 * Invariants:
 *   - ONE_HISTORY_SHAPE: work items and knowledge return the same item schema (the packages own both schemas).
 *   - NOTE_NOT_BODY: the reason comes from Dolt history, never from the row.
 *   - BOUNDED_READ: newest first, at most 50 versions; values over 4 KB are truncated and flagged.
 * Side-effects: none
 * Links: hub change-history-design, change-history-fleet-adoption
 * @public
 */

import { knowledgeHistoryOperation } from "@cogni/shared-knowledge-store/contracts";
import {
  ChangeReasonSchema,
  HistoryEntrySchema,
  HistoryOutputSchema,
  workItemsHistoryOperation,
} from "@cogni/work-items";
import type { z } from "zod";

export {
  ChangeReasonSchema,
  HistoryEntrySchema,
  HistoryOutputSchema,
  knowledgeHistoryOperation,
  workItemsHistoryOperation,
};

export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
export type HistoryOutput = z.infer<typeof HistoryOutputSchema>;
