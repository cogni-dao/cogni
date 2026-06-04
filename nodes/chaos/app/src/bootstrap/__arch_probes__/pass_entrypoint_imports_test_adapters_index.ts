// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/__arch_probes__/pass_entrypoint_imports_test_adapters_index`
 * Purpose: Architecture probe demonstrating valid import from test adapters entry point (must pass dependency-cruiser).
 * Scope: Tests canonical import from @/adapters/test (index.ts). Does NOT test internal imports.
 * Invariants: Must pass dependency-cruiser with no violations (entry point imports allowed).
 * Side-effects: none
 * Notes: Used by tests/arch/entrypoints-boundaries.spec.ts to validate entry point enforcement.
 * Links: .dependency-cruiser.cjs (entry point rules), tests/arch/entrypoints-boundaries.spec.ts
 * @public
 */

import type { FakeMetricsAdapter } from "@/adapters/test";
export type ProbePass = typeof FakeMetricsAdapter;
