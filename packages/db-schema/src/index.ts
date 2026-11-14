// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/db-schema`
 * Purpose: Root barrel re-exporting all schema slices for consumers that need the full schema.
 * Scope: Re-exports only. Does not define any tables.
 * Invariants: Must re-export every slice so the resulting namespace matches src/shared/db/schema.ts.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/package-isolation-rules, https://node-template.cognidao.org/knowledge/rls-tenant-isolation
 * @public
 */

export * from "./agent-authority";
export * from "./ai";
export * from "./ai-threads";
export * from "./attribution";
export * from "./auth";
export * from "./billing";
export * from "./compute";
export * from "./connections";
export * from "./identity";
// poly-copy-trade relocated to nodes/poly/app/src/shared/db/copy-trade.ts (task.0322)
export * from "./profile";
export * from "./refs";
export * from "./scheduling";
