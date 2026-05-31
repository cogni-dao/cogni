// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/__arch_probes__/pass_contracts_imports_shared`
 * Purpose: Architecture probe demonstrating valid contracts→shared import (should pass dependency-cruiser).
 * Scope: Tests allowed import from contracts to shared layer. Does NOT test forbidden imports.
 * Invariants: Must successfully import from @/shared without violating layer boundaries.
 * Side-effects: none
 * Notes: Used by tests/arch/contracts-layer-boundaries.spec.ts to validate contracts layer rules.
 * Links: .dependency-cruiser.cjs (contracts layer rules), tests/arch/contracts-layer-boundaries.spec.ts
 * @public
 */

import { someUtil } from "@/shared/__arch_probes__/util";
export const probePass = someUtil;
