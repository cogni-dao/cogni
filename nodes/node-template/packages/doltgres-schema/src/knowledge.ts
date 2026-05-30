// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/node-template-doltgres-schema/knowledge`
 * Purpose: node-template's Doltgres knowledge schema — pure re-export of the shared
 *   syntropy seed bundle from @cogni/knowledge-base. As of spike.5004 the
 *   contribution-flow tables (knowledge_contributions + knowledge_contribution_commits)
 *   are also shared base; this file no longer defines them locally.
 * Scope: Re-exports only. Targets Doltgres via pg wire protocol (dialect: postgresql).
 * Invariants:
 *   - DB_PER_NODE: this schema applies to `knowledge_node_template` only.
 *   - SCHEMA_GENERIC_CONTENT_SPECIFIC: per-node specificity lives in row content
 *     (domain registry values, `tags` JSONB, `source_node`), not in column shape.
 *   - Dialect separation: this package is NOT globbed by nodes/node-template/drizzle.config.ts
 *     (which targets Postgres); only by nodes/node-template/drizzle.doltgres.config.ts.
 * Side-effects: none
 * Links: docs/spec/knowledge-data-plane.md, docs/spec/knowledge-syntropy.md, docs/research/dolt-baseline-port-syntropy.md
 * @public
 */

// Syntropy seed bundle — all 6 knowledge-family tables shared via @cogni/knowledge-base.
// Drizzle-kit walks this re-export when generating migrations for knowledge_node_template.
export {
  citations,
  domains,
  knowledge,
  knowledgeContributions,
  knowledgeContributionCommits,
  sources,
} from "@cogni/knowledge-base";
