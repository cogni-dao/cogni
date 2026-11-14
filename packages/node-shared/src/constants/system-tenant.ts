// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/constants/system-tenant`
 * Purpose: Cogni system tenant identity constants. Naming: COGNI_SYSTEM_* = tenant-like identity, distinct from SYSTEM_ACTOR (ops/audit in @cogni/ids/system).
 * Scope: Deterministic UUID PKs for the cogni_system billing account and its owner principal. Does not contain business logic or authorization checks.
 * Invariants: IDs match the seeded records in migration 0008_seed_system_tenant.sql. All PKs are valid UUID v4.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/system-tenant-identity
 * @public
 */

/** Billing account UUID for the system tenant. Seeded by migration. */
export const COGNI_SYSTEM_BILLING_ACCOUNT_ID =
  "00000000-0000-4000-b000-000000000000" as const;

/** User (principal) UUID that owns the system tenant billing account. Seeded by migration. */
export const COGNI_SYSTEM_PRINCIPAL_USER_ID =
  "00000000-0000-4000-a000-000000000001" as const;

/** Human-readable slug for the system tenant billing account. Stored in billing_accounts.slug, not the PK. */
export const COGNI_SYSTEM_BILLING_ACCOUNT_SLUG = "cogni_system" as const;

/** Credit ledger reason for revenue share bonus credits minted to system tenant. */
export const PLATFORM_REVENUE_SHARE_REASON = "platform_revenue_share" as const;
