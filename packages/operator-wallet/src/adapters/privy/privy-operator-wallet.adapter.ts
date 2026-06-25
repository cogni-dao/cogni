// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/operator-wallet/adapters/privy`
 * Purpose: Privy-managed operator wallet adapter — submits typed intents to Privy HSM for signing.
 * Scope: Implements OperatorWalletPort via @privy-io/node SDK. Does not hold raw key material — Privy HSM signs transactions. Does not load env or manage process lifecycle.
 * Invariants: KEY_NEVER_IN_APP, ADDRESS_VERIFIED_AT_STARTUP (lazy on first use), NO_GENERIC_SIGNING, PRIVY_SIGNED_REQUESTS.
 * Side-effects: IO (Privy API calls for wallet verification and tx submission)
 * Links: docs/spec/operator-wallet.md
 * @public
 */

import { splitV2ABI } from "@0xsplits/splits-sdk/constants/abi";
import type { AuthorizationContext } from "@privy-io/node";
import { PrivyClient } from "@privy-io/node";
import type { Address, Hex } from "viem";
import { createPublicClient, encodeFunctionData, getAddress, http } from "viem";

import {
  calculateSplitAllocations,
  OPENROUTER_CRYPTO_FEE_PPM,
  SPLIT_TOTAL_ALLOCATION,
} from "../../domain/split-allocation.js";
import {
  ERC20_APPROVE_ABI,
  ERC20_TRANSFER_ABI,
  TRANSFERS_ABI,
} from "../../domain/transfers-abi.js";
import type {
  OperatorWalletPort,
  TransferIntent,
} from "../../port/operator-wallet.port.js";

/** Base chain ID — hardcoded per spec (chain-specific adapter). */
const BASE_CHAIN_ID = 8453;
const BASE_CAIP2 = `eip155:${BASE_CHAIN_ID}`;

/** Distribution incentive: 0 = no third-party reward for calling distribute(). */
const DISTRIBUTION_INCENTIVE = 0;

/** USDC on Base (6 decimals). Canonical source: nodes/operator/app/src/shared/web3/chain.ts:USDC_TOKEN_ADDRESS */
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const USDC_DECIMALS = 6n;

/**
 * OpenRouter minimum charge is $1.00 (spike.0090). With 5% fee = $1.05 USDC total.
 * Reject intents below this to avoid wasting gas on charges that will fail.
 */
const MIN_TOPUP_USDC = 1_050_000n; // $1.05 in USDC atomic units (6 decimals)

/**
 * Allowlisted Coinbase Commerce Transfers contracts on Base.
 * Per spike.0090: OpenRouter returns 0x0305... (newer contract), NOT the old 0xeADE6...
 * Stored lowercased for comparison.
 */
const ALLOWED_TRANSFERS_CONTRACTS = new Set([
  "0x03059433bcdb6144624cc2443159d9445c32b7a8", // Current OpenRouter Transfers contract
]);

export interface PrivyOperatorWalletConfig {
  /** Privy application ID */
  appId: string;
  /** Privy application secret */
  appSecret: string;
  /** Privy signing key for signed requests (wallet-auth:... token) */
  signingKey: string;
  /** Expected operator wallet address from repo-spec (checksummed) */
  expectedAddress: string;
  /** Split contract address (from payments_in.credits_topup.receiving_address) */
  splitAddress: string;
  /** DAO treasury address from repo-spec (cogni_dao.dao_contract) */
  treasuryAddress: string;
  /**
   * Human-custodied steward wallet address (repo-spec payments_out.steward_wallet).
   * Optional — when absent, withdrawToSteward fails closed. Pinned destination
   * for outbound vendor funding; the caller can never choose the recipient.
   */
  stewardAddress?: string;
  /** Billing markup factor in PPM (e.g., 2_000_000n for 2.0x) */
  markupPpm: bigint;
  /** Revenue share in PPM (e.g., 750_000n for 75%) */
  revenueSharePpm: bigint;
  /** Max per-tx top-up in USD. Per OPERATOR_MAX_TOPUP_USD. */
  maxTopUpUsd: number;
  /** Base RPC URL for on-chain confirmation polling (e.g., EVM_RPC_URL) */
  rpcUrl: string;
}

/**
 * Privy-managed operator wallet adapter.
 * Verifies wallet address against repo-spec on first use (lazy verification).
 * Submits typed intents to Privy HSM — no raw key material in process.
 */
export class PrivyOperatorWalletAdapter implements OperatorWalletPort {
  private readonly client: PrivyClient;
  private readonly authContext: AuthorizationContext;
  private readonly expectedAddress: string;
  private readonly splitAddress: string;
  private readonly treasuryAddress: string;
  private readonly stewardAddress: string | undefined;
  private readonly markupPpm: bigint;
  private readonly revenueSharePpm: bigint;
  private readonly maxTopUpUsd: number;
  private readonly rpcClient: ReturnType<typeof createPublicClient>;
  private verifyPromise: Promise<void> | undefined;
  private walletId: string | undefined;

  constructor(config: PrivyOperatorWalletConfig) {
    this.client = new PrivyClient({
      appId: config.appId,
      appSecret: config.appSecret,
    });
    this.authContext = {
      authorization_private_keys: [config.signingKey],
    };
    this.expectedAddress = getAddress(config.expectedAddress);
    this.splitAddress = getAddress(config.splitAddress);
    this.treasuryAddress = getAddress(config.treasuryAddress);
    this.stewardAddress = config.stewardAddress
      ? getAddress(config.stewardAddress)
      : undefined;
    this.markupPpm = config.markupPpm;
    this.revenueSharePpm = config.revenueSharePpm;
    this.maxTopUpUsd = config.maxTopUpUsd;
    this.rpcClient = createPublicClient({
      transport: http(config.rpcUrl),
    });
  }

  /**
   * Verify that Privy reports a wallet matching the expected address from repo-spec.
   * Called lazily on first use. Throws on mismatch (ADDRESS_VERIFIED_AT_STARTUP).
   * Uses a promise lock to prevent redundant concurrent API calls.
   */
  private async verify(): Promise<void> {
    if (this.walletId) return;
    if (this.verifyPromise) return this.verifyPromise;

    this.verifyPromise = this.doVerify();
    return this.verifyPromise;
  }

  private async doVerify(): Promise<void> {
    let found = false;
    for await (const wallet of this.client.wallets().list()) {
      if (wallet.address.toLowerCase() === this.expectedAddress.toLowerCase()) {
        this.walletId = wallet.id;
        found = true;
        break;
      }
    }

    if (!found) {
      this.verifyPromise = undefined; // Allow retry
      throw new Error(
        `[OperatorWallet] ADDRESS_VERIFIED_AT_STARTUP failed: Privy has no wallet matching ` +
          `repo-spec address ${this.expectedAddress}. Run scripts/provision-operator-wallet.ts first.`
      );
    }
  }

  private getWalletId(): string {
    if (!this.walletId) {
      throw new Error(
        "[OperatorWallet] walletId not set — call verify() first"
      );
    }
    return this.walletId;
  }

  async getAddress(): Promise<string> {
    await this.verify();
    return this.expectedAddress;
  }

  getSplitAddress(): string {
    return this.splitAddress;
  }

  async distributeSplit(token: string): Promise<string> {
    await this.verify();

    // Derive allocations from billing constants (same math as deploy-split.ts)
    const { operatorAllocation, treasuryAllocation } =
      calculateSplitAllocations(
        this.markupPpm,
        this.revenueSharePpm,
        OPENROUTER_CRYPTO_FEE_PPM
      );

    // Sort recipients ascending by address (0xSplits requirement)
    const entries = [
      {
        address: this.expectedAddress as Address,
        allocation: operatorAllocation,
      },
      {
        address: this.treasuryAddress as Address,
        allocation: treasuryAllocation,
      },
    ].sort((a, b) =>
      a.address.toLowerCase().localeCompare(b.address.toLowerCase())
    );

    const splitParams = {
      recipients: entries.map((e) => e.address),
      allocations: entries.map((e) => e.allocation),
      totalAllocation: SPLIT_TOTAL_ALLOCATION,
      distributionIncentive: DISTRIBUTION_INCENTIVE,
    };

    // Encode distribute(splitParams, token, distributor) using splitV2ABI
    const data = encodeFunctionData({
      abi: splitV2ABI,
      functionName: "distribute",
      args: [splitParams, token as Address, this.expectedAddress as Address],
    });

    const result = await this.client
      .wallets()
      .ethereum()
      .sendTransaction(this.getWalletId(), {
        caip2: BASE_CAIP2,
        params: {
          transaction: {
            to: this.splitAddress,
            data,
            value: 0,
          },
        },
        authorization_context: this.authContext,
      });

    // Wait for distribute to confirm on-chain so USDC is available for subsequent steps
    await this.rpcClient.waitForTransactionReceipt({
      hash: result.hash as Hex,
      confirmations: 1,
    });

    return result.hash;
  }

  async fundOpenRouterTopUp(intent: TransferIntent): Promise<string> {
    await this.verify();

    // Gate 1: SENDER_MATCH — intent sender must be the operator wallet
    const intentSender = getAddress(intent.metadata.sender);
    if (intentSender !== this.expectedAddress) {
      throw new Error(
        `[OperatorWallet] SENDER_MISMATCH: intent sender ${intentSender} !== ` +
          `expected ${this.expectedAddress}`
      );
    }

    // Gate 2: DESTINATION_ALLOWLIST — contract must be allowlisted
    const contractAddress = getAddress(intent.metadata.contract_address);
    if (!ALLOWED_TRANSFERS_CONTRACTS.has(contractAddress.toLowerCase())) {
      throw new Error(
        `[OperatorWallet] DESTINATION_ALLOWLIST: contract ${contractAddress} not in allowlist`
      );
    }

    // Gate 3: CHAIN_MISMATCH — must be Base
    if (intent.metadata.chain_id !== BASE_CHAIN_ID) {
      throw new Error(
        `[OperatorWallet] CHAIN_MISMATCH: chain_id ${intent.metadata.chain_id} !== ${BASE_CHAIN_ID}`
      );
    }

    // Gate 4: MIN/MAX_TOPUP — total USDC must be within bounds
    const recipientAmount = BigInt(intent.call_data.recipient_amount);
    const feeAmount = BigInt(intent.call_data.fee_amount);
    const totalUsdc = recipientAmount + feeAmount;
    if (totalUsdc < MIN_TOPUP_USDC) {
      throw new Error(
        `[OperatorWallet] MIN_TOPUP: total ${totalUsdc} below minimum ${MIN_TOPUP_USDC} ($1.05)`
      );
    }
    const capUsdc = BigInt(this.maxTopUpUsd) * 10n ** USDC_DECIMALS;
    if (totalUsdc > capUsdc) {
      throw new Error(
        `[OperatorWallet] MAX_TOPUP_CAP: total ${totalUsdc} exceeds cap ${capUsdc} ` +
          `(${this.maxTopUpUsd} USD)`
      );
    }

    // Note: SIMULATE_BEFORE_BROADCAST (spec invariant) is handled by Privy's
    // infrastructure — the SDK does not expose a pre-sign simulation hook.
    // If simulation is needed app-side, inject a publicClient in a future revision.

    // Step 1: ERC-20 approve USDC to Transfers contract
    // Must wait for on-chain confirmation before submitting transferTokenPreApproved,
    // otherwise Privy simulates the transfer against stale allowance and reverts.
    const approveData = encodeFunctionData({
      abi: ERC20_APPROVE_ABI,
      functionName: "approve",
      args: [contractAddress, totalUsdc],
    });

    const approveResult = await this.client
      .wallets()
      .ethereum()
      .sendTransaction(this.getWalletId(), {
        caip2: BASE_CAIP2,
        params: {
          transaction: { to: USDC_ADDRESS, data: approveData, value: 0 },
        },
        authorization_context: this.authContext,
      });

    // Wait for approve to confirm on-chain before proceeding
    await this.rpcClient.waitForTransactionReceipt({
      hash: approveResult.hash as Hex,
      confirmations: 1,
    });

    // Step 2: Parse deadline — ISO 8601 string → unix timestamp
    const deadlineBigInt = /^\d+$/.test(intent.call_data.deadline)
      ? BigInt(intent.call_data.deadline)
      : BigInt(
          Math.floor(new Date(intent.call_data.deadline).getTime() / 1000)
        );

    // Step 3: Encode transferTokenPreApproved
    const transferData = encodeFunctionData({
      abi: TRANSFERS_ABI,
      functionName: "transferTokenPreApproved",
      args: [
        {
          recipientAmount,
          deadline: deadlineBigInt,
          recipient: intent.call_data.recipient as Address,
          recipientCurrency: intent.call_data.recipient_currency as Address,
          refundDestination: intent.call_data.refund_destination as Address,
          feeAmount,
          id: intent.call_data.id as Hex,
          operator: intent.call_data.operator as Address,
          signature: intent.call_data.signature as Hex,
          prefix: intent.call_data.prefix as Hex,
        },
      ],
    });

    // Step 4: Submit via Privy HSM
    const result = await this.client
      .wallets()
      .ethereum()
      .sendTransaction(this.getWalletId(), {
        caip2: BASE_CAIP2,
        params: {
          transaction: { to: contractAddress, data: transferData, value: 0 },
        },
        authorization_context: this.authContext,
      });

    return result.hash;
  }

  async withdrawToSteward(amountUsdcAtomic: bigint): Promise<string> {
    await this.verify();

    // Gate 1: STEWARD_CONFIGURED — fail closed when no destination is pinned
    if (!this.stewardAddress) {
      throw new Error(
        "[OperatorWallet] STEWARD_NOT_CONFIGURED: payments_out.steward_wallet " +
          "missing from repo-spec — cannot fund the steward wallet"
      );
    }

    // Gate 2: POSITIVE_AMOUNT
    if (amountUsdcAtomic <= 0n) {
      throw new Error(
        `[OperatorWallet] INVALID_AMOUNT: ${amountUsdcAtomic} must be > 0`
      );
    }

    // Gate 3: MAX_TOPUP_CAP — reuse the per-tx USD cap that bounds top-ups
    const capUsdc = BigInt(this.maxTopUpUsd) * 10n ** USDC_DECIMALS;
    if (amountUsdcAtomic > capUsdc) {
      throw new Error(
        `[OperatorWallet] MAX_TOPUP_CAP: ${amountUsdcAtomic} exceeds cap ${capUsdc} ` +
          `(${this.maxTopUpUsd} USD)`
      );
    }

    // Fixed ERC-20 transfer to the config-pinned steward address. The caller
    // controls only the amount, never the recipient (NO_GENERIC_SIGNING).
    const data = encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: "transfer",
      args: [this.stewardAddress as Address, amountUsdcAtomic],
    });

    const result = await this.client
      .wallets()
      .ethereum()
      .sendTransaction(this.getWalletId(), {
        caip2: BASE_CAIP2,
        params: {
          transaction: { to: USDC_ADDRESS, data, value: 0 },
        },
        authorization_context: this.authContext,
      });

    // Wait for confirmation so the steward wallet balance is settled before
    // a human is told to proceed with the vendor checkout.
    await this.rpcClient.waitForTransactionReceipt({
      hash: result.hash as Hex,
      confirmations: 1,
    });

    return result.hash;
  }
}
