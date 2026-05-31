// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/__arch_probes__/pass_ports_imports_core`
 * Purpose: Architecture probe demonstrating valid ports→core import (should pass dependency-cruiser).
 * Scope: Tests allowed import from ports to core layer. Does NOT test forbidden imports.
 * Invariants: Must successfully import from @/core without violating layer boundaries.
 * Side-effects: none
 * Notes: Used by tests/arch/ports-layer-boundaries.spec.ts to validate ports layer rules.
 * Links: .dependency-cruiser.cjs (ports layer rules), tests/arch/ports-layer-boundaries.spec.ts
 * @public
 */

import { AuthSession } from "@/core/__arch_probes__/auth";
export const probePass = AuthSession;
