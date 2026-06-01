// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/__arch_probes__/pass_app_imports_bootstrap`
 * Purpose: Architecture probe demonstrating valid app→bootstrap import (should pass dependency-cruiser).
 * Scope: Tests allowed import from app to bootstrap layer. Does NOT test forbidden imports.
 * Invariants: Must successfully import from @/bootstrap without violating layer boundaries.
 * Side-effects: none
 * Notes: Used by tests/arch/app-layer-boundaries.spec.ts to validate app layer rules.
 * Links: .dependency-cruiser.cjs (app layer rules), tests/arch/app-layer-boundaries.spec.ts
 * @public
 */

import { resolveAiDeps } from "@/bootstrap/__arch_probes__/container";
export const probePass = resolveAiDeps;
