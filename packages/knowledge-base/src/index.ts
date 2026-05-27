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

// Schema (Drizzle table definitions — drizzle-kit owns migrations). The base
// bundle only carries tables every knowledge-capable node uses unchanged.
// Per-node contribution metadata (knowledge_contributions etc.) lives in each
// node's own doltgres-schema package — see operator/packages/doltgres-schema.
export { citations, domains, knowledge, sources } from "./schema.js";

// Seeds
export { BASE_KNOWLEDGE_SEEDS } from "./seeds/base.js";
export { BASE_DOMAIN_SEEDS } from "./seeds/domains.js";
