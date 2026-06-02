// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/operator-wallet`
 * Purpose: Re-export operator wallet port from @cogni/operator-wallet package.
 * Scope: Re-exports only. Canonical definitions live in the package. Does not define local types.
 * Invariants: REPO_SPEC_AUTHORITY — port definition owned by @cogni/operator-wallet.
 * Side-effects: none
 * Links: packages/operator-wallet/src/port/operator-wallet.port.ts
 * @public
 */

export type {
  OperatorWalletPort,
  TransferIntent,
} from "@cogni/operator-wallet";
