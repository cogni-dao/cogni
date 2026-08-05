// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/aragon-osx/wallet-resolver`
 * Purpose: Read-only port that resolves an attribution claimant key to the CONTRIBUTOR's own EVM wallet.
 * Scope: Defines the ClaimantWalletResolver port + result types only; does not perform I/O — the Postgres adapter that reads user_bindings / users lives in @cogni/db-client.
 * Invariants:
 * - RESOLVER_READ_ONLY: the port never writes a binding; an unresolved claimant returns null, never a synthesized address.
 * - RESOLVER_CONTRIBUTOR_WALLET: it resolves to the contributor's OWN wallet, never an operator/treasury wallet (no-central-custody).
 * - RESOLVER_NULL_IS_UNRESOLVED: null wallet ⇒ the claimant surfaces as the `claimants_unresolved` settlement blocker.
 * Side-effects: none (port + types only)
 * Links: docs/spec/identity-model.md, docs/spec/decentralized-user-identity.md, docs/spec/tokenomics.md
 * @public
 */

import type { HexAddress } from "./types";

/**
 * Outcome of resolving one claimant key to a wallet.
 * `wallet` is null when no EVM wallet binding exists for the resolved person —
 * the caller must NOT invent an address; the unresolved claimant becomes a blocker.
 */
export interface ClaimantWalletResolution {
  /** The claimant key as supplied (e.g. `user:<id>` or `identity:github:<externalId>`). */
  readonly claimantKey: string;
  /** Canonical person identity (`users.id`) the claimant resolved to, or null if the identity itself is unresolved. */
  readonly userId: string | null;
  /** The contributor's own EVM wallet, or null when no wallet binding exists. */
  readonly wallet: HexAddress | null;
}

/**
 * Read-only port: resolve attribution claimant keys to the contributors' own EVM wallets.
 *
 * Implementations resolve the canonical `user_id` first (direct for `user:<id>`,
 * via `user_bindings` for `identity:<provider>:<externalId>`), then resolve that
 * user's wallet from their bindings. They MUST be side-effect free (no binding writes).
 */
export interface ClaimantWalletResolver {
  /**
   * Resolve a batch of claimant keys to wallets.
   * Every input key appears exactly once in the output; order is not guaranteed.
   * Unknown / unresolved keys return `{ userId, wallet: null }`.
   */
  resolveWallets(
    claimantKeys: readonly string[]
  ): Promise<readonly ClaimantWalletResolution[]>;
}
