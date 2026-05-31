// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/__arch_probes__/pass_features_imports_components`
 * Purpose: Architecture probe demonstrating valid features→components import (must pass dependency-cruiser).
 * Scope: Tests allowed cross-layer import. Does NOT test forbidden imports.
 * Invariants: Must be accepted by dependency-cruiser with no violations.
 * Side-effects: none
 * Notes: Used by tests/arch/features-layer-boundaries.spec.ts to validate features boundary enforcement.
 * Links: .dependency-cruiser.cjs (features layer rules), tests/arch/features-layer-boundaries.spec.ts
 * @public
 */

import { Button } from "@/components/__arch_probes__/Button";
export const probePass = Button;
