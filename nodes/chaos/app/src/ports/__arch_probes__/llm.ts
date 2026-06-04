// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/__arch_probes__/llm`
 * Purpose: Architecture probe stub for dependency-cruiser boundary testing.
 * Scope: Provides minimal export for import graph validation. Does NOT implement real logic.
 * Invariants: Exports constant for dependency tracking only.
 * Side-effects: none
 * Notes: Used by tests/arch/ to validate layer boundaries via dependency-cruiser.
 * Links: .dependency-cruiser.cjs, tests/arch/
 * @public
 */

export const LlmService = 1;
