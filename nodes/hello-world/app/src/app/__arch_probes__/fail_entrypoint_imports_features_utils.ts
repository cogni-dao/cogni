// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/__arch_probes__/fail_entrypoint_imports_features_utils`
 * Purpose: Architecture probe demonstrating invalid import from features utils (must fail dependency-cruiser).
 * Scope: Tests forbidden internal module import. Does NOT test canonical imports.
 * Invariants: Must be rejected by dependency-cruiser with no-internal-features-imports violation.
 * Side-effects: none
 * Notes: Used by tests/arch/entrypoints-boundaries.spec.ts to validate entry point enforcement.
 * Links: .dependency-cruiser.cjs (entry point rules), tests/arch/entrypoints-boundaries.spec.ts
 * @public
 */

import { authHelpers } from "@/features/__arch_probes__/utils/authHelpers";
export const probeFail = authHelpers;
