// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/auth/session`
 * Purpose: Canonical session identity type shared across layers.
 * Scope: Minimal user identity fields used by app facades and adapters; does not contain runtime behavior.
 * Invariants: id is always DB UUID; serializable primitives only, no runtime behavior; fields are strict nullable (string | null), never optional.
 * Side-effects: none
 * Notes: walletAddress is null when user authenticated via OAuth (GitHub) without a linked wallet.
 * Links: app/_lib/auth/session
 * @public
 */
export interface SessionUser {
  /**
   * Primary database identifier (UUID).
   * Maps to `users.id` in the `auth` schema.
   * NEVER use wallet address here; use `walletAddress` field instead.
   */
  id: string;
  walletAddress: string | null;
  displayName: string | null;
  avatarColor: string | null;
}
