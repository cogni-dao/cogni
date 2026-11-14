// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/db/schema.auth`
 * Purpose: Minimal NextAuth schema for JWT-only strategy with SIWE.
 * Scope: Only users table needed for JWT strategy. Does not include database sessions, OAuth accounts, or email verification tables.
 * Invariants: wallet_address is the primary user identifier for SIWE authentication.
 * Side-effects: none (schema definitions only)
 * Notes: JWT strategy does not use sessions or accounts tables.
 * Links: packages/db-schema/src/index.ts
 * @public
 */

// Re-export users from refs (canonical location for FK targets)
export { users } from "./refs";
