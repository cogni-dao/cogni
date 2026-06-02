// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/__arch_probes__/fail_entrypoint_imports_ports_internal`
 * Purpose: Architecture probe demonstrating invalid import from internal port file (must fail dependency-cruiser).
 * Scope: Tests forbidden internal module import from app layer. Does NOT test canonical imports.
 * Invariants: Must be rejected by dependency-cruiser with no-internal-ports-imports violation.
 * Side-effects: none
 * Notes: Used by tests/arch/entrypoints-boundaries.spec.ts to validate entry point enforcement.
 * Links: .dependency-cruiser.cjs (entry point rules), tests/arch/entrypoints-boundaries.spec.ts
 * @public
 */

import type { LlmService } from "@/ports/llm.port";
export type ProbeFail = LlmService;
