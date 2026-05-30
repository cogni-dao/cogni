// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/node-template-doltgres-schema`
 * Purpose: Root barrel for node-template's node-local Drizzle schema targeting the Doltgres knowledge plane (`knowledge_node_template`). Re-exports every slice under this package.
 * Scope: Re-exports only. Does not define any tables.
 * Invariants: Re-exports every schema slice so cross-process consumers (node-template app, future Temporal workers) can import from one place without reaching into app/src/.
 * Side-effects: none
 * Links: docs/spec/knowledge-data-plane.md, docs/spec/packages-architecture.md, work/items/task.5077.node-template-doltgres-substrate.md
 * @public
 */

export * from "./knowledge";
export * from "./work-items";
