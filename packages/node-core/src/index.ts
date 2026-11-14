// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/node-core`
 * Purpose: Shared domain models, types, and pure business logic for all node apps.
 * Scope: Pure domain code — accounts, ai, attribution, billing, chat, payments. Does NOT contain adapters, ports, or framework code.
 * Invariants:
 *   - PURE_LIBRARY: No process lifecycle, no env vars, no framework deps
 *   - NO_SRC_IMPORTS: Never imports @/ or src/ paths
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/node-app-shell-contract, https://node-template.cognidao.org/knowledge/package-isolation-rules
 * @public
 */

// Re-export entire core public surface
export * from "./core/public";

// Re-export types
export * from "./types/ai-events";
export * from "./types/billing";
export * from "./types/payments";
export * from "./types/run-context";
export * from "./types/usage";
