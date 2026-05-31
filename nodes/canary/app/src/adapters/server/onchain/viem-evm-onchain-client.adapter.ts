// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/onchain/viem-evm-onchain-client`
 * Purpose: Production EVM on-chain client using viem for RPC operations.
 * Scope: Implements EvmOnchainClient interface with real RPC calls. Does not implement business logic.
 * Invariants: Validates chain ID against repo-spec config at construction; requires EVM_RPC_URL.
 * Side-effects: IO (RPC calls to EVM node)
 * Notes: Used by EvmRpcOnChainVerifierAdapter and future treasury/ownership adapters.
 * Links: docs/spec/onchain-readers.md, docs/spec/payments-design.md
 * @public
 */

import {
  type Abi,
  type ContractFunctionArgs,
  type ContractFunctionName,
  createPublicClient,
  http,
  type Log,
  type PublicClient,
  type Transaction,
  type TransactionReceipt,
} from "viem";

import { getPaymentConfig } from "@/shared/config/repoSpec.server";
import { serverEnv } from "@/shared/env";
import { CHAIN, ERC20_ABI } from "@/shared/web3";
import type { EvmOnchainClient } from "@/shared/web3/onchain/evm-onchain-client.interface";

/**
 * Production EVM on-chain client using viem.
 * Validates configuration lazily (on first method call) to allow builds without EVM_RPC_URL.
 */
export class ViemEvmOnchainClient implements EvmOnchainClient {
  private client: PublicClient | null = null;

  private getClient(): PublicClient {
    if (this.client) {
      return this.client;
    }

    const env = serverEnv();
    const config = getPaymentConfig();
    if (!config) {
      throw new Error("[ViemEvmOnchainClient] Payment rails not activated");
    }

    // Validate chain ID matches repo-spec
    if (config.chainId !== CHAIN.id) {
      throw new Error(
        `[ViemEvmOnchainClient] Chain mismatch: repo-spec declares ${config.chainId}, CHAIN constant is ${CHAIN.id}`
      );
    }

    // Require EVM_RPC_URL in production/preview/dev
    if (!env.EVM_RPC_URL) {
      throw new Error(
        "[ViemEvmOnchainClient] EVM_RPC_URL is required for on-chain verification. " +
          "Set it in your environment or use APP_ENV=test for fake adapter."
      );
    }

    this.client = createPublicClient({
      chain: CHAIN,
      transport: http(env.EVM_RPC_URL),
    });

    return this.client;
  }

  async getTransaction(txHash: `0x${string}`): Promise<Transaction | null> {
    const client = this.getClient();
    try {
      const tx = await client.getTransaction({ hash: txHash });
      return tx;
    } catch (error) {
      // viem throws if transaction not found
      if (
        error instanceof Error &&
        error.message.includes("Transaction not found")
      ) {
        return null;
      }
      throw error;
    }
  }

  async getTransactionReceipt(
    txHash: `0x${string}`
  ): Promise<TransactionReceipt | null> {
    const client = this.getClient();
    try {
      const receipt = await client.getTransactionReceipt({ hash: txHash });
      return receipt;
    } catch (error) {
      // viem throws if receipt not found (pending tx)
      if (
        error instanceof Error &&
        error.message.includes("could not be found")
      ) {
        return null;
      }
      throw error;
    }
  }

  async getBlockNumber(): Promise<bigint> {
    const client = this.getClient();
    return client.getBlockNumber();
  }

  async getLogs(params: {
    address: `0x${string}`;
    event: {
      name: string;
      inputs: readonly { name: string; type: string; indexed?: boolean }[];
    };
    args?: Record<string, unknown>;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<Log[]> {
    const client = this.getClient();
    const logs = await client.getLogs({
      address: params.address,
      event: {
        type: "event",
        name: params.event.name,
        inputs: params.event.inputs.map((input) => ({
          name: input.name,
          type: input.type,
          indexed: input.indexed ?? false,
        })),
      },
      args: params.args,
      fromBlock: params.fromBlock,
      toBlock: params.toBlock,
    });

    return logs;
  }

  async getNativeBalance(address: `0x${string}`): Promise<bigint> {
    const client = this.getClient();
    return client.getBalance({ address });
  }

  async getErc20Balance(params: {
    tokenAddress: `0x${string}`;
    holderAddress: `0x${string}`;
  }): Promise<bigint> {
    const client = this.getClient();
    const balance = await client.readContract({
      address: params.tokenAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [params.holderAddress],
    });
    return balance as bigint;
  }

  async getBytecode(address: `0x${string}`): Promise<`0x${string}` | null> {
    const client = this.getClient();
    const code = await client.getBytecode({ address });
    return code ?? null;
  }

  async readContract<
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
  }): Promise<unknown> {
    const client = this.getClient();
    return client.readContract({
      address: params.address,
      abi: params.abi,
      functionName: params.functionName,
      args: params.args,
    });
  }
}
