// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/operator-doltgres-schema`
 * Purpose: Root barrel for operator's node-local Drizzle schema targeting the Doltgres knowledge plane (`knowledge_operator`). Re-exports every slice under this package.
 * Scope: Re-exports only. Does not define any tables.
 * Invariants: Re-exports every schema slice so cross-process consumers (operator app, future Temporal workers) can import from one place without reaching into app/src/.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/knowledge-data-plane, https://node-template.cognidao.org/knowledge/package-isolation-rules, work/items/task.0423.doltgres-work-items-source-of-truth.md
 * @public
 */

export * from "./knowledge";
export * from "./work-items";
