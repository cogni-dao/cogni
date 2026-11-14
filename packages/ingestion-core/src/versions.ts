// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ingestion-core/versions`
 * Purpose: Source adapter version constants — single source of truth for poll + webhook adapter versioning.
 * Scope: Registration metadata only. Bump when schema changes affect payloadHash or receipt_id format. Does not contain adapter implementations or platform-specific deps.
 * Invariants: Both poll and webhook adapters for a source MUST use the same version constant.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/attribution-epoch-ledger
 * @public
 */

/** GitHub source adapter version. Shared by poll (scheduler-worker) and webhook (app) adapters. */
export const GITHUB_ADAPTER_VERSION = "0.3.0" as const;
