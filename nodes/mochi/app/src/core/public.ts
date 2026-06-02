// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@core/public`
 * Purpose: Node-local core entry point. Re-exports shared platform core from @cogni/node-core. Nodes extend this with node-specific domain models.
 * Scope: Re-export barrel + node-specific extensions. Does NOT duplicate platform core logic.
 * Invariants: Re-exports @cogni/node-core platform surface; node-specific named exports below
 * Side-effects: none
 * Links: @cogni/node-core, docs/spec/node-app-shell.md
 * @public
 */

// Shared platform core — all nodes get these
export * from "@cogni/node-core";

// Node-specific core domain goes below this line.
// Example: export { ReservationModel } from "./reservations/model";
