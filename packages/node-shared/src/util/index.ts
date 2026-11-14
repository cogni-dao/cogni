// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/node-shared/util`
 * Purpose: Pure utility functions (UUID validation).
 * Scope: cn() stays app-local (UI dep). accountId uses node:crypto, not re-exported here.
 * Invariants: PURE_LIBRARY — no UI deps, no framework deps.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/package-isolation-rules
 * @public
 */

export { isValidUuid } from "./uuid";
