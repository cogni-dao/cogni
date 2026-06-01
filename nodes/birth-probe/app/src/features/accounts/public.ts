// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/accounts/public`
 * Purpose: Single entrypoint for accounts feature - controlled API surface for app layer.
 * Scope: Re-exports business operations and error contracts. Does not expose internal implementation details.
 * Invariants: Single entry point per feature, stable public API, no internal structure leakage
 * Side-effects: none
 * Notes: Follows core/public.ts pattern for bounded context boundaries
 * Links: Used by app facades and routes for account operations
 * @public
 */

export type { AccountsFeatureError } from "./errors";
export {
  isAccountsFeatureError,
  mapAccountsPortErrorToFeature,
} from "./errors";
