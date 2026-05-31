// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/__arch_probes__/fail_adapters_imports_app`
 * Purpose: Architecture probe demonstrating invalid adapters→app import (must fail dependency-cruiser).
 * Scope: Tests forbidden cross-layer import. Does NOT test valid imports.
 * Invariants: Must be rejected by dependency-cruiser with not-in-allowed violation.
 * Side-effects: none
 * Notes: Used by tests/arch/adapters-layer-boundaries.spec.ts to validate adapters boundary enforcement.
 * Links: .dependency-cruiser.cjs (adapters layer rules), tests/arch/adapters-layer-boundaries.spec.ts
 * @public
 */

import { appRoute } from "@/app/__arch_probes__/route";
export const probeFail = appRoute;
