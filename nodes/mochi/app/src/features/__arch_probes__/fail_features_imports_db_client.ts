// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/__arch_probes__/fail_features_imports_db_client`
 * Purpose: Arch probe that intentionally violates db-client-server-only rule.
 * Scope: Test-only fixture. Does not run in production.
 * Invariants: Must trigger depcruise violation when scanned.
 * Side-effects: none
 * Links: .dependency-cruiser.cjs, tests/arch/features-layer-boundaries.spec.ts
 * @internal
 */

// Features layer cannot import db-client (server-only package)
// @ts-expect-error - intentional violation for arch testing
import { createAppDbClient } from "@cogni/db-client";

export const probe = createAppDbClient;
