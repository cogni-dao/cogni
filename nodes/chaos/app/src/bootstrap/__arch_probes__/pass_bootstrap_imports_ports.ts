// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/__arch_probes__/pass_bootstrap_imports_ports`
 * Purpose: Architecture probe demonstrating valid bootstrap→ports import (should pass dependency-cruiser).
 * Scope: Tests allowed import from bootstrap to ports layer. Does NOT test forbidden imports.
 * Invariants: Must successfully import from @/ports without violating layer boundaries.
 * Side-effects: none
 * Notes: Used by tests/arch/bootstrap-layer-boundaries.spec.ts to validate bootstrap layer rules.
 * Links: .dependency-cruiser.cjs (bootstrap layer rules), tests/arch/bootstrap-layer-boundaries.spec.ts
 * @public
 */

import { LlmService } from "@/ports/__arch_probes__/llm";
export const probePass = LlmService;
