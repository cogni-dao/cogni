// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@core/__arch_probes__/fail_core_imports_ports`
 * Purpose: Architecture probe demonstrating invalid core→ports import (must fail dependency-cruiser).
 * Scope: Tests forbidden cross-layer import. Does NOT test valid imports.
 * Invariants: Must be rejected by dependency-cruiser with not-in-allowed violation.
 * Side-effects: none
 * Notes: Used by tests/arch/core-layer-boundaries.spec.ts to validate core boundary enforcement.
 * Links: .dependency-cruiser.cjs (core-only-core rule), tests/arch/core-layer-boundaries.spec.ts
 * @public
 */

import { LlmService } from "@/ports/__arch_probes__/llm";
export const probeFail = LlmService;
