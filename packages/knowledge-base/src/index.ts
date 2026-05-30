// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base`
 * Purpose: Base knowledge Drizzle schema (the syntropy seed bundle) + seeds inherited by every knowledge-capable node.
 * Scope: Schema definitions and seed data. Does not perform I/O — runtime adapters live in `@cogni/knowledge-store`.
 * Invariants: Nodes inherit this base. Domain-specific extensions go in the node's own package.
 * Side-effects: none
 * Links: docs/spec/knowledge-data-plane.md, docs/spec/knowledge-syntropy.md
 * @public
 */

export type { NewWorkItemRow, WorkItemRow } from "./schema.js";
// Schema (Drizzle table definitions — drizzle-kit owns migrations). The base
// bundle carries every table that every knowledge-capable node uses unchanged:
// the 4 core knowledge tables + the contribution-flow metadata tables + the
// work_items lifecycle store. Per-node packages re-export from here so the
// schema cannot drift across nodes (spike.5004).
export {
  citations,
  domains,
  knowledge,
  knowledgeContributionCommits,
  knowledgeContributions,
  sources,
  workItems,
} from "./schema.js";

// Seeds
export { BASE_KNOWLEDGE_SEEDS } from "./seeds/base.js";
export { BASE_DOMAIN_SEEDS } from "./seeds/domains.js";
