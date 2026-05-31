// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/web3/onchain/evm-onchain-client.interface`
 * Purpose: Internal infra seam for EVM RPC operations (NOT a domain port).
 * Scope: Wraps viem operations for transaction queries. Does not implement business logic or validation.
 * Invariants: All EVM adapters MUST use this interface (never call viem/RPC directly).
 * Side-effects: none (interface definition only)
 * Notes: Production uses ViemEvmOnchainClient; tests use FakeEvmOnchainClient.
 * Links: docs/spec/onchain-readers.md, docs/spec/payments-design.md
 * @public
 */

import type {
  Abi,
  ContractFunctionArgs,
  ContractFunctionName,
  Log,
  Transaction,
  TransactionReceipt,
} from "viem";

/**
 * EVM on-chain client interface for RPC operations.
 * Internal infrastructure seam - NOT a domain port.
 *
 * All EVM adapters (payment verifier, treasury, ownership) MUST use this interface
 * instead of calling viem/RPC directly. This enables:
 * - Test isolation (FakeEvmOnchainClient for unit tests)
 * - Centralized RPC configuration
 * - Future rate limiting and caching
 */
export interface EvmOnchainClient {
  /**
   * Fetches a transaction by hash.
   * Returns null if transaction not found.
   */
  getTransaction(txHash: `0x${string}`): Promise<Transaction | null>;

  /**
   * Fetches a transaction receipt by hash.
   * Returns null if receipt not found (transaction pending or not mined).
   */
  getTransactionReceipt(
    txHash: `0x${string}`
  ): Promise<TransactionReceipt | null>;

  /**
   * Gets the current block number.
   * Used for confirmation count calculations.
   */
  getBlockNumber(): Promise<bigint>;

  /**
   * Gets logs matching the filter criteria.
   * Used for querying ERC20 Transfer events.
   */
  getLogs(params: {
    address: `0x${string}`;
    event: {
      name: string;
      inputs: readonly { name: string; type: string; indexed?: boolean }[];
    };
    args?: Record<string, unknown>;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<Log[]>;

  /**
   * Gets the native token balance (ETH) for an address.
   * Used for native token balance queries.
   */
  getNativeBalance(address: `0x${string}`): Promise<bigint>;

  /**
   * Gets ERC20 token balance for a holder address.
   * Used for token balance queries (e.g., USDC treasury balance).
   */
  getErc20Balance(params: {
    tokenAddress: `0x${string}`;
    holderAddress: `0x${string}`;
  }): Promise<bigint>;

  /**
   * Returns deployed contract bytecode at address.
   * Useful for verifying that a contract exists at an address.
   */
  getBytecode(address: `0x${string}`): Promise<`0x${string}` | null>;

  /**
   * Generic contract read helper (typed wrapper over viem readContract).
   * Keeps all contract reads behind the same infra seam.
   */
  readContract<
    const TAbi extends Abi,
    TFunctionName extends ContractFunctionName<TAbi, "view" | "pure">,
    const TArgs extends ContractFunctionArgs<
      TAbi,
      "view" | "pure",
      TFunctionName
    >,
  >(params: {
    address: `0x${string}`;
    abi: TAbi;
    functionName: TFunctionName;
    args: TArgs;
  }): Promise<unknown>;
}
