// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/__arch_probes__/pass_entrypoint_imports_server`
 * Purpose: Architecture probe demonstrating valid import from ports server.ts (must pass dependency-cruiser).
 * Scope: Tests server-only entry point import. Does NOT test internal imports.
 * Invariants: Must be accepted by dependency-cruiser with no violations.
 * Side-effects: none
 * Notes: Used by tests/arch/entrypoints-boundaries.spec.ts to validate entry point enforcement.
 * Links: .dependency-cruiser.cjs (entry point rules), tests/arch/entrypoints-boundaries.spec.ts
 * @public
 */

import type { ScheduleUserPort } from "@/ports/server";
export type ProbePass = ScheduleUserPort;
