// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/operator-wallet/adapters/privy/privy-node-wallet-provisioner`
 * Purpose: Create or find a Privy wallet owned by a P-256 public key from the node owner's browser (story.0083).
 * Scope: Wallet creation + owner-key lookup only. Does not receive, derive or return key material, and does not sign.
 * Invariants:
 *   - OWNER_IS_THE_BROWSER_KEY: `owner.public_key` is the only owner ever set; no `owner_id`, no
 *     `additional_signers`, no `policy_ids` (this step grants no signer).
 *   - IDEMPOTENT_CREATE: the caller's `privy-idempotency-key` is passed on every create.
 *   - CHECKSUM_ADDRESS: returned addresses are EIP-55 checksummed.
 * Side-effects: IO (Privy REST API)
 * Links: https://node-template.cognidao.org/knowledge/set-up-operator-wallet
 * @public
 */

import { PrivyClient } from "@privy-io/node";
import { getAddress } from "viem";

export interface PrivyNodeWalletProvisionerConfig {
  readonly appId: string;
  readonly appSecret: string;
}

export interface ProvisionedNodeWallet {
  readonly id: string;
  readonly address: string;
}

export interface NodeWalletProvisioner {
  /** Wallets (Ethereum) whose owner quorum includes this base64 SPKI public key. */
  findByOwnerKey(
    ownerPublicKey: string
  ): Promise<readonly ProvisionedNodeWallet[]>;
  /** Create an Ethereum wallet owned by this base64 SPKI public key. */
  createOwned(input: {
    readonly ownerPublicKey: string;
    readonly idempotencyKey: string;
  }): Promise<ProvisionedNodeWallet>;
}

export function createPrivyNodeWalletProvisioner(
  config: PrivyNodeWalletProvisionerConfig
): NodeWalletProvisioner {
  const client = new PrivyClient({
    appId: config.appId,
    appSecret: config.appSecret,
  });
  return {
    async findByOwnerKey(ownerPublicKey) {
      const found: ProvisionedNodeWallet[] = [];
      for await (const wallet of client.wallets().list({
        chain_type: "ethereum",
        authorization_key: ownerPublicKey,
      })) {
        found.push({ id: wallet.id, address: getAddress(wallet.address) });
        // The key is generated per node; more than a couple of hits is already ambiguous.
        if (found.length > 2) break;
      }
      return found;
    },
    async createOwned({ ownerPublicKey, idempotencyKey }) {
      // The SDK takes the idempotency key as a header param on the params object and sends it as the
      // `privy-idempotency-key` header (it is not part of the request body).
      const wallet = await client.wallets().create({
        chain_type: "ethereum",
        owner: { public_key: ownerPublicKey },
        "privy-idempotency-key": idempotencyKey,
      });
      return { id: wallet.id, address: getAddress(wallet.address) };
    },
  };
}
