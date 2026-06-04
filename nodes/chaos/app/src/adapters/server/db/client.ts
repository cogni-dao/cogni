// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/db`
 * Purpose: Safe database adapter barrel for server-side database access.
 * Scope: Re-exports app-role client, Database type, and tenant-scoping helpers. Does NOT export getServiceDb (BYPASSRLS).
 * Invariants: No BYPASSRLS access through this barrel
 * Side-effects: none (re-exports only)
 * Notes: Service-role access requires direct import from drizzle.service-client.ts (depcruiser-gated).
 * Links: docs/spec/database-rls.md
 * @public
 */

export { type Database, getAppDb } from "./drizzle.client";
export { setTenantContext, withTenantScope } from "./tenant-scope";
