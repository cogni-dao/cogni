// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/__arch_probes__/pass_app_imports_contracts`
 * Purpose: Architecture probe demonstrating valid app→contracts import (should pass dependency-cruiser).
 * Scope: Tests allowed import from app to contracts layer. Does NOT test forbidden imports.
 * Invariants: Must successfully import from @/contracts without violating layer boundaries.
 * Side-effects: none
 * Notes: Used by tests/arch/app-layer-boundaries.spec.ts to validate app layer rules.
 * Links: .dependency-cruiser.cjs (app layer rules), tests/arch/app-layer-boundaries.spec.ts
 * @public
 */

import { aiCompleteOperation } from "@cogni/node-contracts";
export const probePass = aiCompleteOperation;
