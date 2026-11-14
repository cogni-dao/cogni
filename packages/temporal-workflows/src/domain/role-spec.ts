// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/temporal-workflows/domain/role-spec`
 * Purpose: RoleSpec type + constants for operator roles. Binds capability (graph) to operational config.
 * Scope: Pure types and constants. Does not perform I/O or depend on runtime infrastructure.
 * Invariants:
 *   - THREE_REGISTRIES: RoleSpec is operational config, NOT graph config (that's CatalogEntry)
 *   - Code-first constants for crawl. Walk phase may extract to config files.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/temporal-workflow-rules
 * @public
 */

/**
 * Operational contract for an agent role.
 * Binds a graph capability to schedule, queue filter, and metrics.
 */
export interface RoleSpec {
  readonly roleId: string;
  /** Fully-qualified graph ID (e.g., "langgraph:operating-review") */
  readonly graphId: string;
  readonly workflowShape: "webhook" | "scheduled-sweep";
  readonly model: string;
  readonly schedule?: { readonly cron: string };
  /** Queue filter for scheduled-sweep shape. Maps to WorkQuery fields. */
  readonly queueFilter?: {
    readonly statuses?: readonly string[];
    readonly labels?: readonly string[];
    readonly types?: readonly string[];
  };
  readonly concurrency: number;
}

// ── Role Constants ──────────────────────────────────────

export const OPERATING_REVIEW_ROLE: RoleSpec = {
  roleId: "operating-review",
  graphId: "langgraph:operating-review",
  workflowShape: "scheduled-sweep",
  model: "openai/gpt-4o-mini",
  schedule: { cron: "0 */12 * * *" },
  queueFilter: {},
  concurrency: 1,
};

export const GIT_REVIEWER_ROLE: RoleSpec = {
  roleId: "git-reviewer",
  graphId: "langgraph:git-reviewer",
  workflowShape: "scheduled-sweep",
  model: "openai/gpt-4o-mini",
  schedule: { cron: "0 */4 * * *" },
  queueFilter: { statuses: ["needs_merge"] },
  concurrency: 1,
};
