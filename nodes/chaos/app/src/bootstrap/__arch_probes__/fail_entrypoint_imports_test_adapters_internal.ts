// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/__arch_probes__/fail_entrypoint_imports_test_adapters_internal`
 * Purpose: Architecture probe demonstrating invalid import from internal test adapter file (must fail dependency-cruiser).
 * Scope: Tests forbidden internal module import from bootstrap layer. Does NOT test canonical imports.
 * Invariants: Must be rejected by dependency-cruiser with no-internal-test-adapter-imports violation.
 * Side-effects: none
 * Notes: Used by tests/arch/entrypoints-boundaries.spec.ts to validate entry point enforcement.
 * Links: .dependency-cruiser.cjs (entry point rules), tests/arch/entrypoints-boundaries.spec.ts
 * @public
 */

import { FakeMetricsAdapter } from "@/adapters/test/metrics/fake-metrics.adapter";
export const probeFail = FakeMetricsAdapter;
