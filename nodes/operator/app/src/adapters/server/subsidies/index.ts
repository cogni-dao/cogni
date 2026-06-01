// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/subsidies`
 * Purpose: Public server adapter exports for subsidy distribution rails.
 * Scope: Re-exports prototype rail adapters for bootstrap composition.
 * Invariants: named exports only.
 * Side-effects: none
 * Links: ports/subsidy-distribution-rail.port.ts
 * @public
 */

export { AlloPrototypeSubsidyRailAdapter } from "./allo-prototype.adapter";
export { SablierFlowPrototypeSubsidyRailAdapter } from "./sablier-flow-prototype.adapter";
