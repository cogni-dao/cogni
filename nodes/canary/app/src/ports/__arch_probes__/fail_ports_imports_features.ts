// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/__arch_probes__/fail_ports_imports_features`
 * Purpose: Architecture probe demonstrating invalid ports→features import (must fail dependency-cruiser).
 * Scope: Tests forbidden cross-layer import. Does NOT test valid imports.
 * Invariants: Must be rejected by dependency-cruiser with not-in-allowed violation.
 * Side-effects: none
 * Notes: Used by tests/arch/ports-layer-boundaries.spec.ts to validate ports boundary enforcement.
 * Links: .dependency-cruiser.cjs (ports layer rules), tests/arch/ports-layer-boundaries.spec.ts
 * @public
 */

import { Terminal } from "@/features/__arch_probes__/Terminal";
export const probeFail = Terminal;
