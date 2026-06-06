// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/__arch_probes__/fail_app_imports_adapters`
 * Purpose: Architecture probe demonstrating invalid app→adapters direct import (must fail dependency-cruiser).
 * Scope: Tests forbidden cross-layer import. Does NOT test valid imports.
 * Invariants: Must be rejected by dependency-cruiser with not-in-allowed violation.
 * Side-effects: none
 * Notes: Used by tests/arch/app-layer-boundaries.spec.ts to validate app boundary enforcement.
 * Links: .dependency-cruiser.cjs (app layer rules), tests/arch/app-layer-boundaries.spec.ts
 * @public
 */

import { LiteLlmAdapter } from "@/adapters/__arch_probes__/litellm";
export const probeFail = LiteLlmAdapter;
