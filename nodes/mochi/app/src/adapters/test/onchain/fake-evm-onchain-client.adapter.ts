// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/test/onchain/fake-evm-onchain-client`
 * Purpose: Fake EVM on-chain client for deterministic testing without RPC calls.
 * Scope: Implements EvmOnchainClient interface with configurable in-memory responses. Does not make network calls.
 * Invariants: Deterministic behavior based on configuration; allows testing all RPC scenarios.
 * Side-effects: none (in-memory only)
 * Notes: Configure via setTransaction/setReceipt/setBlockNumber helpers. Tracks call history for assertions.
 * Links: Implements EvmOnchainClient interface
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

import type { EvmOnchainClient } from "@/shared/web3/onchain/evm-onchain-client.interface";

/**
 * Fake EVM on-chain client for testing.
 * Allows configuring responses to test all RPC scenarios without network calls.
 */
export class FakeEvmOnchainClient implements EvmOnchainClient {
  private transactions: Map<string, Transaction | null> = new Map();
  private receipts: Map<string, TransactionReceipt | null> = new Map();
  private blockNumber: bigint = 1000000n;
  private logs: Log[] = [];
  private nativeBalances: Map<string, bigint> = new Map();
  private erc20Balances: Map<string, bigint> = new Map(); // key: "tokenAddress:holderAddress"
  private bytecodes: Map<string, `0x${string}`> = new Map();
  private contractReads: Map<string, unknown> = new Map(); // key: `${address}:${functionName}:${JSON.stringify(args)}`

  // Call tracking for assertions
  public getTransactionCalls: `0x${string}`[] = [];
  public getReceiptCalls: `0x${string}`[] = [];
  public getBlockNumberCalls: number = 0;
  public getLogsCalls: number = 0;
  public getNativeBalanceCalls: `0x${string}`[] = [];
  public getErc20BalanceCalls: Array<{
    tokenAddress: `0x${string}`;
    holderAddress: `0x${string}`;
  }> = [];
  public getBytecodeCalls: `0x${string}`[] = [];
  public readContractCalls: Array<{
    address: `0x${string}`;
    functionName: string;
    args: readonly unknown[];
  }> = [];

  /**
   * Configure a transaction response for a given hash.
   * Pass null to simulate "not found".
   */
  setTransaction(txHash: `0x${string}`, tx: Transaction | null): void {
    this.transactions.set(txHash.toLowerCase(), tx);
  }

  /**
   * Configure a receipt response for a given hash.
   * Pass null to simulate "pending" or "not found".
   */
  setReceipt(txHash: `0x${string}`, receipt: TransactionReceipt | null): void {
    this.receipts.set(txHash.toLowerCase(), receipt);
  }

  /**
   * Configure the current block number.
   */
  setBlockNumber(blockNumber: bigint): void {
    this.blockNumber = blockNumber;
  }

  /**
   * Configure logs to return from getLogs.
   */
  setLogs(logs: Log[]): void {
    this.logs = logs;
  }

  /**
   * Configure native balance for a given address.
   */
  setNativeBalance(address: `0x${string}`, balance: bigint): void {
    this.nativeBalances.set(address.toLowerCase(), balance);
  }

  /**
   * Configure ERC20 token balance for a holder.
   */
  setErc20Balance(
    tokenAddress: `0x${string}`,
    holderAddress: `0x${string}`,
    balance: bigint
  ): void {
    const key = `${tokenAddress.toLowerCase()}:${holderAddress.toLowerCase()}`;
    this.erc20Balances.set(key, balance);
  }

  /**
   * Configure bytecode for an address.
   * Use "0x" to simulate empty code; omit to simulate null (unknown).
   */
  setBytecode(address: `0x${string}`, bytecode: `0x${string}`): void {
    this.bytecodes.set(address.toLowerCase(), bytecode);
  }

  /**
   * Configure a readContract response (for deterministic tests).
   */
  setReadContractResult(params: {
    address: `0x${string}`;
    functionName: string;
    args: readonly unknown[];
    result: unknown;
  }): void {
    const key = `${params.address.toLowerCase()}:${params.functionName}:${JSON.stringify(
      params.args
    )}`;
    this.contractReads.set(key, params.result);
  }

  /**
   * Reset all configured responses and call history.
   */
  reset(): void {
    this.transactions.clear();
    this.receipts.clear();
    this.blockNumber = 1000000n;
    this.logs = [];
    this.nativeBalances.clear();
    this.erc20Balances.clear();
    this.bytecodes.clear();
    this.contractReads.clear();
    this.getTransactionCalls = [];
    this.getReceiptCalls = [];
    this.getBlockNumberCalls = 0;
    this.getLogsCalls = 0;
    this.getNativeBalanceCalls = [];
    this.getErc20BalanceCalls = [];
    this.getBytecodeCalls = [];
    this.readContractCalls = [];
  }

  async getTransaction(txHash: `0x${string}`): Promise<Transaction | null> {
    this.getTransactionCalls.push(txHash);
    const tx = this.transactions.get(txHash.toLowerCase());
    return tx ?? null;
  }

  async getTransactionReceipt(
    txHash: `0x${string}`
  ): Promise<TransactionReceipt | null> {
    this.getReceiptCalls.push(txHash);
    const receipt = this.receipts.get(txHash.toLowerCase());
    return receipt ?? null;
  }

  async getBlockNumber(): Promise<bigint> {
    this.getBlockNumberCalls++;
    return this.blockNumber;
  }

  async getLogs(_params: {
    address: `0x${string}`;
    event: {
      name: string;
      inputs: readonly { name: string; type: string; indexed?: boolean }[];
    };
    args?: Record<string, unknown>;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<Log[]> {
    this.getLogsCalls++;
    return this.logs;
  }

  async getNativeBalance(address: `0x${string}`): Promise<bigint> {
    this.getNativeBalanceCalls.push(address);
    const balance = this.nativeBalances.get(address.toLowerCase());
    return balance ?? 0n;
  }

  async getErc20Balance(params: {
    tokenAddress: `0x${string}`;
    holderAddress: `0x${string}`;
  }): Promise<bigint> {
    this.getErc20BalanceCalls.push(params);
    const key = `${params.tokenAddress.toLowerCase()}:${params.holderAddress.toLowerCase()}`;
    const balance = this.erc20Balances.get(key);
    return balance ?? 0n;
  }

  async getBytecode(address: `0x${string}`): Promise<`0x${string}` | null> {
    this.getBytecodeCalls.push(address);
    const code = this.bytecodes.get(address.toLowerCase());
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
    this.readContractCalls.push({
      address: params.address,
      functionName: String(params.functionName),
      args: Array.isArray(params.args) ? [...params.args] : [],
    });
    const key = `${params.address.toLowerCase()}:${params.functionName}:${JSON.stringify(
      params.args
    )}`;
    return this.contractReads.get(key);
  }
}

// ============================================================================
// Test Singleton Accessor (APP_ENV=test only)
// ============================================================================

/**
 * Singleton instance for test mode.
 * Ensures all adapters use the same FakeEvmOnchainClient instance
 * so tests can configure it via getTestEvmOnchainClient().
 */
let _testInstance: FakeEvmOnchainClient | null = null;

/**
 * Gets the singleton test instance.
 * Used by DI container in test mode and by tests to configure behavior.
 *
 * @returns Singleton FakeEvmOnchainClient instance
 */
export function getTestEvmOnchainClient(): FakeEvmOnchainClient {
  if (!_testInstance) {
    _testInstance = new FakeEvmOnchainClient();
  }
  return _testInstance;
}

/**
 * Resets the singleton instance to default state.
 * Should be called in test beforeEach/afterEach to ensure clean state.
 */
export function resetTestEvmOnchainClient(): void {
  if (_testInstance) {
    _testInstance.reset();
  }
}
