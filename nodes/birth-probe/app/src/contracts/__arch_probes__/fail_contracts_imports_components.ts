// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/__arch_probes__/fail_contracts_imports_components`
 * Purpose: Architecture probe demonstrating invalid contracts→components import (must fail dependency-cruiser).
 * Scope: Tests forbidden cross-layer import. Does NOT test valid imports.
 * Invariants: Must be rejected by dependency-cruiser with not-in-allowed violation.
 * Side-effects: none
 * Notes: Used by tests/arch/contracts-layer-boundaries.spec.ts to validate contracts boundary enforcement.
 * Links: .dependency-cruiser.cjs (contracts layer rules), tests/arch/contracts-layer-boundaries.spec.ts
 * @public
 */

import { Button } from "@/components/__arch_probes__/Button";
export const probeFail = Button;
