// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared`
 * Purpose: Shared utilities barrel — app-local re-exports (env, config, db, observability, web3, util).
 * Scope: Hex layer extension point. Pure library code extracted to @cogni/node-shared.
 * Invariants: Pure re-exports only, no side effects.
 * Side-effects: none
 * @public
 */

export * from "./env";
export * from "./observability";
export * from "./util";
