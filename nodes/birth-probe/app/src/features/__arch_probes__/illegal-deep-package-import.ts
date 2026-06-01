// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/__arch_probes__/illegal-deep-package-import`
 * Purpose: Arch probe that intentionally violates no-deep-package-imports rule.
 * Scope: Test-only fixture; does NOT run in production.
 * Invariants: Must trigger depcruise violation when scanned.
 * Side-effects: none
 * Links: .dependency-cruiser.cjs, tests/arch/packages-layer-boundaries.spec.ts
 * @internal
 */

// @ts-expect-error - intentional violation for arch testing
import { encodeTokenVotingSetup } from "../../../../../packages/aragon-osx/src/encoding";

export const probe = encodeTokenVotingSetup;
