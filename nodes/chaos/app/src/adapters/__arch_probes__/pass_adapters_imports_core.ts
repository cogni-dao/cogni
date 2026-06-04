// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/__arch_probes__/pass_adapters_imports_core`
 * Purpose: Architecture probe demonstrating valid adapters→core import (should pass dependency-cruiser).
 * Scope: Tests allowed import from adapters to core layer. Does NOT test forbidden imports.
 * Invariants: Must successfully import from @/core without violating layer boundaries.
 * Side-effects: none
 * Notes: Used by tests/arch/adapters-layer-boundaries.spec.ts to validate adapters layer rules.
 * Links: .dependency-cruiser.cjs (adapters layer rules), tests/arch/adapters-layer-boundaries.spec.ts
 * @public
 */

import { AuthSession } from "@/core/__arch_probes__/auth";
export const probePass = AuthSession;
