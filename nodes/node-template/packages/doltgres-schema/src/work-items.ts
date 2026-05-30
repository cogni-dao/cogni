// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/node-template-doltgres-schema/work-items`
 * Purpose: node-template's Doltgres `work_items` table — pure re-export of the shared
 *   shape from @cogni/knowledge-base. Promoted to base 2026-05-30 (spike.5004) so
 *   every knowledge-capable node owns its own work_items without re-defining the schema.
 * Scope: Re-exports only. Targets Doltgres via pg wire protocol (dialect: postgresql).
 * Invariants:
 *   - DB_PER_NODE: this schema applies to `knowledge_node_template` only.
 *   - SCHEMA_GENERIC_CONTENT_SPECIFIC: per-node routing lives in row content
 *     (`node`, `labels`, `spec_refs`), not in column shape.
 *   - NODE_NOT_NULL: `node` column is NOT NULL with default 'shared'.
 *   - ID_RANGE_RESERVED: enforced in the adapter, not at the DB layer.
 *   - PATCH_ALLOWLIST: server-managed columns (`id`, `created_at`, `updated_at`)
 *     are not in the adapter's PATCH allowlist.
 * Side-effects: none
 * Links: docs/spec/work-items-port.md, docs/spec/knowledge-data-plane.md, docs/research/dolt-baseline-port-syntropy.md
 * @public
 */

export {
  workItems,
  type NewWorkItemRow,
  type WorkItemRow,
} from "@cogni/knowledge-base";
