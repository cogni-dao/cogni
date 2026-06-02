// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/db/schema`
 * Purpose: Barrel re-export of all database schema from @cogni/db-schema package.
 * Scope: Re-exports only. Does not define any tables - all schema definitions live in packages/db-schema.
 * Invariants: This file must not define any tables - only re-export from the package.
 * Side-effects: none
 * Links: docs/spec/packages-architecture.md
 * @public
 */

export * from "@cogni/db-schema/ai";
export * from "@cogni/db-schema/ai-threads";
export * from "@cogni/db-schema/attribution";
// Domain slices
export * from "@cogni/db-schema/auth";
export * from "@cogni/db-schema/billing";
export * from "@cogni/db-schema/identity";
export * from "@cogni/db-schema/profile";
// Core FK targets (users, billingAccounts)
export * from "@cogni/db-schema/refs";
export * from "@cogni/db-schema/scheduling";
