// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/capabilities/work-item`
 * Purpose: Generic work item capability interface for AI tools.
 * Scope: Defines WorkItemCapability — query + patch over work items (a status move is a patch), and the store-agnostic patch conflict error. Does not contain implementations or app-domain concepts.
 * Invariants:
 *   - CAPABILITY_INJECTION: Implementation injected at bootstrap, not imported
 *   - PORTS_ARE_AUTHORITY: Delegates to WorkItemQueryPort + WorkItemCommandPort
 * Side-effects: none (interface only)
 * Links: https://node-template.cognidao.org/knowledge/work-item-status-machine
 * @public
 */

import type { WorkItemDto, WorkItemPatchInput } from "@cogni/work-items";

export interface WorkItemAssignee {
  readonly kind: WorkItemDto["assignees"][number]["kind"];
  readonly id: string;
}

export type WorkItemInfo = Omit<WorkItemDto, "assignees"> & {
  readonly assignees: readonly (
    | WorkItemDto["assignees"][number]
    | WorkItemAssignee
  )[];
};

/**
 * Parameters for querying work items.
 */
export interface WorkItemQueryParams {
  readonly statuses?: readonly string[];
  readonly types?: readonly string[];
  readonly text?: string;
  readonly actor?: string;
  readonly projectId?: string;
  readonly limit?: number;
  /** Exact ids to fetch (bounded). */
  readonly ids?: readonly string[];
  /** Opaque pagination cursor from a previous page's `nextCursor`. */
  readonly cursor?: string;
}

/** One page of a work-item query. `nextCursor` absent ⇒ last page. */
export interface WorkItemQueryPage {
  readonly items: readonly WorkItemInfo[];
  readonly nextCursor?: string;
}

/**
 * Generic work item capability for AI tools.
 *
 * Implementation is injected at bootstrap time (per CAPABILITY_INJECTION).
 * The implementation is responsible for:
 * - Delegating to WorkItemQueryPort and WorkItemCommandPort
 * - Enforcing the status gates: every status write is a `patch` with `set.status`, gated by the store (task.0122)
 * - Resolving revision for optimistic concurrency
 */
export interface WorkItemCapability {
  /** List work items matching filters. */
  query(params: WorkItemQueryParams): Promise<readonly WorkItemInfo[]>;

  /**
   * Same as `query`, plus the pagination cursor. Optional: implementations without
   * pagination omit it and the tool reports no `nextCursor`.
   */
  queryPage?(params: WorkItemQueryParams): Promise<WorkItemQueryPage>;

  /**
   * Patch work item fields: the PATCH route's `set` (status, priority, rank, labels, summary, scores, ...).
   *
   * `expectedRevision` (optional) is compare-and-set on the row's `revision`: the
   * write lands only if the row is still at that revision. A moved row throws
   * `WorkItemPatchConflictError` and nothing is written. Omitted ⇒ unconditioned.
   */
  patch(input: {
    id: string;
    expectedRevision?: number;
    /** Why this change happens (task.0086): required; one line, at most 25 words and 240 characters; stored in history, never in the item. */
    reason: string;
    /** Hub atoms this change used (at most 8); the store pins each to a commit in history. */
    cites?: WorkItemPatchInput["cites"];
    set: WorkItemPatchInput["set"];
  }): Promise<WorkItemInfo>;
}

/**
 * A `patch` with `expectedRevision` lost the compare-and-set: the row moved since it
 * was read. Nothing was written; the caller re-reads and retries (e.g. next cycle).
 * Implementations translate their store's conflict into this so tools stay store-agnostic.
 */
export class WorkItemPatchConflictError extends Error {
  readonly id: string;
  readonly expectedRevision: number;
  readonly currentRevision: number;

  constructor(id: string, expectedRevision: number, currentRevision: number) {
    super(
      `Work item ${id} is at revision ${currentRevision}, expected ${expectedRevision}; nothing written`
    );
    this.name = "WorkItemPatchConflictError";
    this.id = id;
    this.expectedRevision = expectedRevision;
    this.currentRevision = currentRevision;
  }
}
