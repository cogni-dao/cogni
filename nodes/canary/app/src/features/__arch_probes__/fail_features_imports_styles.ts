// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/__arch_probes__/fail_features_imports_styles`
 * Purpose: Architecture probe demonstrating invalid features→styles import (must fail dependency-cruiser).
 * Scope: Tests forbidden cross-layer import. Does NOT test valid imports.
 * Invariants: Must be rejected by dependency-cruiser with not-in-allowed violation.
 * Side-effects: none
 * Notes: Used by tests/arch/features-layer-boundaries.spec.ts to validate features boundary enforcement.
 * Links: .dependency-cruiser.cjs (features layer rules), tests/arch/features-layer-boundaries.spec.ts
 * @public
 */

import { button } from "@/styles/__arch_probes__/ui";
export const probeFail = button;
