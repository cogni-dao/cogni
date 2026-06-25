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
  buildX402TypedData,
  TRANSFER_WITH_AUTHORIZATION,
} from "../../domain/x402-eip3009.js";
import type {
  OperatorWalletPort,
  X402PaymentParams,
} from "../../port/operator-wallet.port.js";

/** Base chain ID — hardcoded per spec (chain-specific adapter). */
const BASE_CHAIN_ID = 8453;
const BASE_CAIP2 = `eip155:${BASE_CHAIN_ID}`;

/** Distribution incentive: 0 = no third-party reward for calling distribute(). */
const DISTRIBUTION_INCENTIVE = 0;

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
  private readonly markupPpm: bigint;
  private readonly revenueSharePpm: bigint;
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
    this.markupPpm = config.markupPpm;
    this.revenueSharePpm = config.revenueSharePpm;
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

  async signX402Payment(params: X402PaymentParams): Promise<Hex> {
    await this.verify();

    // Gate: the authorizer (`from`) must be this operator wallet. The signature
    // authorizes a debit FROM `from`; signing for any other authorizer is out of
    // scope for the operator wallet (KEY_NEVER_IN_APP — we only hold our own key).
    const authorizer = getAddress(params.from);
    if (authorizer !== this.expectedAddress) {
      throw new Error(
        `[OperatorWallet] X402_AUTHORIZER_MISMATCH: from ${authorizer} !== ` +
          `expected ${this.expectedAddress}`
      );
    }

    // Build the deterministic EIP-712 typed data for USDC EIP-3009 on Base.
    const typed = buildX402TypedData(params);

    // Privy's eth_signTypedData_v4 expects JSON-shaped typed data: numeric values
    // are strings, types are name/type pairs, and the struct name is `primary_type`.
    const result = await this.client
      .wallets()
      .ethereum()
      .signTypedData(this.getWalletId(), {
        params: {
          typed_data: {
            domain: {
              name: typed.domain.name,
              version: typed.domain.version,
              chainId: typed.domain.chainId,
              verifyingContract: typed.domain.verifyingContract,
            },
            types: {
              EIP712Domain: [
                { name: "name", type: "string" },
                { name: "version", type: "string" },
                { name: "chainId", type: "uint256" },
                { name: "verifyingContract", type: "address" },
              ],
              [TRANSFER_WITH_AUTHORIZATION]: [
                ...typed.types[TRANSFER_WITH_AUTHORIZATION],
              ],
            },
            primary_type: typed.primaryType,
            message: {
              from: typed.message.from,
              to: typed.message.to,
              value: typed.message.value.toString(),
              validAfter: typed.message.validAfter.toString(),
              validBefore: typed.message.validBefore.toString(),
              nonce: typed.message.nonce,
            },
          },
        },
        authorization_context: this.authContext,
      });

    return result.signature as Hex;
  }
}
