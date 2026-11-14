// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-worker-service/enrichers/work-item-linker`
 * Purpose: Provides a work-item linker plugin for extracting work-item IDs from event metadata and defining its evaluation payload shape.
 * Scope: Pure plugin implementation for work-item link extraction and payload typing. Does not perform I/O or modify ledger core contracts.
 * Invariants:
 * - ENRICHER_SNAPSHOT_RULE: all external work-item state must be snapshotted into the plugin payload.
 * - INPUTS_HASH_COMPLETE: inputs_hash covers epoch_id, sorted (receipt_id, receipt_payload_hash), and sorted (work_item_id, frontmatter_hash). It does not depend on repo commit SHA for invalidation.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/attribution-plugin-pipeline
 * @internal
 */

/** A detected link between an event and a work item. */
export interface WorkItemLink {
  readonly workItemId: string;
  readonly linkSource: "title" | "body" | "branch" | "label";
}

/** Snapshotted frontmatter for a work item. */
export interface WorkItemSnapshot {
  readonly estimate: number | null;
  readonly priority: number | null;
  readonly status: string | null;
  readonly title: string | null;
  readonly frontmatterHash: string;
  readonly error?: "file_not_found" | "parse_error";
}

/** Full evaluation payload for `cogni.work_item_links.v0`. */
export interface WorkItemLinksPayload {
  readonly repoCommitSha: string;
  readonly workItems: Record<string, WorkItemSnapshot>;
  readonly eventLinks: Record<string, WorkItemLink[]>;
  readonly unlinkedEventIds: string[];
}

/** Pattern: (task|bug|spike|story).\d{4} */
const WORK_ITEM_ID_PATTERN = /\b(task|bug|spike|story)\.\d{4}\b/g;

/**
 * Extract work-item IDs from event metadata fields.
 * Scans title, body, branch, and labels for patterns like task.0102, bug.0037, etc.
 */
export function extractWorkItemIds(
  metadata: Partial<{
    title: string;
    body: string;
    branch: string;
    labels: string[];
  }> | null
): WorkItemLink[] {
  if (!metadata) return [];

  const seen = new Set<string>();
  const links: WorkItemLink[] = [];

  const scan = (
    text: string | undefined | null,
    source: WorkItemLink["linkSource"]
  ): void => {
    if (!text) return;
    for (const match of text.matchAll(WORK_ITEM_ID_PATTERN)) {
      const id = match[0];
      const key = `${id}:${source}`;
      if (!seen.has(key)) {
        seen.add(key);
        links.push({ workItemId: id, linkSource: source });
      }
    }
  };

  scan(metadata.title, "title");
  scan(metadata.body, "body");
  scan(metadata.branch, "branch");
  if (metadata.labels) {
    for (const label of metadata.labels) {
      scan(label, "label");
    }
  }

  return links;
}

/** Namespaced evaluation ref for the work-item linker plugin. */
export const WORK_ITEM_LINKS_EVALUATION_REF = "cogni.work_item_links.v0";

/** Algorithm ref for the work-item linker plugin. */
export const WORK_ITEM_LINKER_ALGO_REF = "work-item-linker-v0";
