// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/__arch_probes__/pass_bootstrap_imports_adapters`
 * Purpose: Architecture probe demonstrating valid bootstrap→adapters import (should pass dependency-cruiser).
 * Scope: Tests allowed import from bootstrap to adapters layer. Does NOT test forbidden imports.
 * Invariants: Must successfully import from @/adapters without violating layer boundaries.
 * Side-effects: none
 * Notes: Used by tests/arch/bootstrap-layer-boundaries.spec.ts to validate bootstrap layer rules.
 * Links: .dependency-cruiser.cjs (bootstrap layer rules), tests/arch/bootstrap-layer-boundaries.spec.ts
 * @public
 */

import { LiteLlmAdapter } from "@/adapters/__arch_probes__/litellm";
export const probePass = LiteLlmAdapter;
