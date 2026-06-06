// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/_fakes/payments/fakes`
 * Purpose: Barrel export for payment test utilities.
 * Scope: Re-exports payment test builders for clean import paths. Does not contain business logic.
 * Invariants: Maintains single import path for all payment test utilities.
 * Side-effects: none
 * Notes: Follow pattern from ai/fakes.ts
 * Links: payment-builders
 * @public
 */

export * from "./mock-services";
export * from "./payment-builders";
