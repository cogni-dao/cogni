// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/__arch_probes__/fail_shared_imports_features`
 * Purpose: Architecture probe demonstrating invalid shared→features import (must fail dependency-cruiser).
 * Scope: Tests forbidden cross-layer import. Does NOT test valid imports.
 * Invariants: Must be rejected by dependency-cruiser with not-in-allowed violation.
 * Side-effects: none
 * Notes: Used by tests/arch/shared-layer-boundaries.spec.ts to validate shared boundary enforcement.
 * Links: .dependency-cruiser.cjs (shared layer rules), tests/arch/shared-layer-boundaries.spec.ts
 * @public
 */

import { Terminal } from "@/features/__arch_probes__/Terminal";
export const probeFail = Terminal;
