// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/__arch_probes__/fail_bootstrap_imports_components`
 * Purpose: Architecture probe demonstrating invalid bootstrap→components import (must fail dependency-cruiser).
 * Scope: Tests forbidden cross-layer import. Does NOT test valid imports.
 * Invariants: Must be rejected by dependency-cruiser with not-in-allowed violation.
 * Side-effects: none
 * Notes: Used by tests/arch/bootstrap-layer-boundaries.spec.ts to validate bootstrap boundary enforcement.
 * Links: .dependency-cruiser.cjs (bootstrap layer rules), tests/arch/bootstrap-layer-boundaries.spec.ts
 * @public
 */

import { Button } from "@/components/__arch_probes__/Button";
export const probeFail = Button;
