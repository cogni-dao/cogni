// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/onchain/viem-treasury`
 * Purpose: Treasury balance adapter using direct RPC calls via EvmOnchainClient.
 * Scope: Implements TreasuryReadPort for USDC balances using viem. Does not handle business logic.
 * Invariants: Validates chainId and treasuryAddress from repo-spec; uses EvmOnchainClient for all RPC; reads USDC address from chain config.
 * Side-effects: IO (RPC calls via EvmOnchainClient)
 * Notes: Phase 2: USDC only. Queries ERC20 balance via getErc20Balance().
 * Links: docs/spec/onchain-readers.md
 * @public
 */

import { formatUnits, getAddress } from "viem";

import type { TreasuryReadPort, TreasurySnapshot } from "@/ports";
import { getPaymentConfig } from "@/shared/config/repoSpec.server";
import { USDC_TOKEN_ADDRESS } from "@/shared/web3";
import type { EvmOnchainClient } from "@/shared/web3/onchain/evm-onchain-client.interface";

/**
 * Treasury adapter using EvmOnchainClient for direct RPC balance queries.
 * Phase 2: USDC balance only via getErc20Balance().
 */
export class ViemTreasuryAdapter implements TreasuryReadPort {
  constructor(private readonly evmClient: EvmOnchainClient) {}

  async getTreasurySnapshot(params: {
    chainId: number;
    treasuryAddress: string;
    tokenAddresses?: string[];
  }): Promise<TreasurySnapshot> {
    // Validate chainId against canonical config
    const config = getPaymentConfig();
    if (!config) {
      throw new Error("[ViemTreasuryAdapter] Payment rails not activated");
    }

    if (params.chainId !== config.chainId) {
      throw new Error(
        `[ViemTreasuryAdapter] Chain ID mismatch: expected ${config.chainId}, got ${params.chainId}`
      );
    }

    const treasuryChecksummed = getAddress(params.treasuryAddress);

    // Phase 2: Only support USDC (no custom tokens yet)
    if (params.tokenAddresses && params.tokenAddresses.length > 0) {
      throw new Error(
        "[ViemTreasuryAdapter] Custom token addresses not yet supported (Phase 2: USDC only)"
      );
    }

    // Query USDC balance + block number in parallel
    const usdcAddress = getAddress(USDC_TOKEN_ADDRESS);
    const [balanceRaw, blockNumber] = await Promise.all([
      this.evmClient.getErc20Balance({
        tokenAddress: usdcAddress as `0x${string}`,
        holderAddress: treasuryChecksummed as `0x${string}`,
      }),
      this.evmClient.getBlockNumber(),
    ]);

    return {
      treasuryAddress: treasuryChecksummed,
      chainId: params.chainId,
      blockNumber,
      balances: [
        {
          token: "USDC",
          tokenAddress: usdcAddress,
          balanceWei: balanceRaw,
          balanceFormatted: formatUnits(balanceRaw, 6), // USDC has 6 decimals
          decimals: 6,
        },
      ],
      timestamp: Date.now(),
    };
  }
}
