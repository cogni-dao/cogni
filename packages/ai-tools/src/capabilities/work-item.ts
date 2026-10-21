// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/capabilities/work-item`
 * Purpose: Generic work item capability interface for AI tools.
 * Scope: Defines WorkItemCapability — query + transition over work items. Does not contain implementations or app-domain concepts.
 * Invariants:
 *   - CAPABILITY_INJECTION: Implementation injected at bootstrap, not imported
 *   - PORTS_ARE_AUTHORITY: Delegates to WorkItemQueryPort + WorkItemCommandPort
 * Side-effects: none (interface only)
 * Links: docs/spec/development-lifecycle.md
 * @public
 */

/**
 * Work item summary returned by the capability.
 * Subset of full WorkItem — enough for agent decision-making.
 */
export interface WorkItemInfo {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly status: string;
  readonly priority?: number;
  readonly rank?: number;
  readonly summary?: string;
  readonly projectId?: string;
  readonly actor?: string;
  readonly labels: readonly string[];
  readonly assignees: readonly WorkItemAssignee[];
  readonly branch?: string;
  readonly pr?: string;
  readonly blockedBy?: string;
  readonly updatedAt: string;
  /** Optimistic-concurrency revision of the row read (store-specific counter). */
  readonly revision?: number;
  /** Measurable "done when" text, when the store carries one. */
  readonly outcome?: string;
  /** Size estimate, when set. */
  readonly estimate?: number;
  /** Parent work item id (e.g. the story a task belongs to). */
  readonly parentId?: string;
  /** Spec / knowledge references the item declares. */
  readonly specRefs?: readonly string[];
}

export interface WorkItemAssignee {
  readonly kind: "user" | "agent" | "system";
  readonly id: string;
}

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
 * Result of transitioning a work item.
 */
export interface WorkItemTransitionResult {
  readonly id: string;
  readonly previousStatus: string;
  readonly newStatus: string;
  readonly revision: number;
}

/**
 * Generic work item capability for AI tools.
 *
 * Implementation is injected at bootstrap time (per CAPABILITY_INJECTION).
 * The implementation is responsible for:
 * - Delegating to WorkItemQueryPort and WorkItemCommandPort
 * - Enforcing valid transitions via the transition table
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

  /** Transition a work item to a new status. */
  transitionStatus(input: {
    id: string;
    toStatus: string;
    reason?: string;
  }): Promise<WorkItemTransitionResult>;

  /** Patch work item fields (priority, labels, summary). */
  patch(input: {
    id: string;
    set: {
      priority?: number;
      labels?: string[];
      summary?: string;
    };
  }): Promise<WorkItemInfo>;
}
