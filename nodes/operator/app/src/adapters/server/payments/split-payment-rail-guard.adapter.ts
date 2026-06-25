// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/payments/split-payment-rail-guard`
 * Purpose: Payment rail guard that proves repo-spec economics match the active 0xSplits V2 contract.
 * Scope: Read-only chain validation; does not create intents, settle payments, or sign transactions.
 * Invariants: Payment intents fail closed when Split contract state cannot be proven to match config.
 * Side-effects: IO (EVM RPC reads)
 * Links: docs/spec/payments-design.md, docs/spec/operator-wallet.md
 * @public
 */

import { splitV2ABI } from "@0xsplits/splits-sdk/constants/abi";
import {
  calculateSplitAllocations,
  numberToPpm,
  OPENROUTER_CRYPTO_FEE_PPM,
  SPLIT_TOTAL_ALLOCATION,
} from "@cogni/operator-wallet";
import {
  type Address,
  encodeAbiParameters,
  getAddress,
  type Hex,
  keccak256,
  parseAbiParameters,
} from "viem";
import {
  type PaymentRailGuardConfig,
  type PaymentRailGuardPort,
  PaymentRailMisconfiguredPortError,
} from "@/ports";
import { CHAIN_ID } from "@/shared/web3";
import type { EvmOnchainClient } from "@/shared/web3/onchain/evm-onchain-client.interface";

const DISTRIBUTION_INCENTIVE = 0;

/**
 * ABI shape of the Push Split V2o2 `SplitV2` struct whose `keccak256(abi.encode(...))`
 * reproduces the on-chain `splitHash()`. The SDK's `hashSplitV2` does NOT match this,
 * so we encode/hash the struct directly with viem.
 */
const SPLIT_V2_STRUCT_PARAMS = parseAbiParameters(
  "(address[] recipients, uint256[] allocations, uint256 totalAllocation, uint16 distributionIncentive)"
);

export interface SplitPaymentRailGuardConfig {
  operatorAddress: string;
  treasuryAddress: string;
}

export class SplitPaymentRailGuardAdapter implements PaymentRailGuardPort {
  constructor(
    private readonly evmClient: EvmOnchainClient,
    private readonly config: SplitPaymentRailGuardConfig
  ) {}

  async assertReady(config: PaymentRailGuardConfig): Promise<void> {
    if (config.chainId !== CHAIN_ID) {
      throw new PaymentRailMisconfiguredPortError(
        "INVALID_CHAIN",
        `Payment rail chain mismatch: repo-spec=${config.chainId}, runtime=${CHAIN_ID}`,
        { repoSpecChainId: config.chainId, runtimeChainId: CHAIN_ID }
      );
    }

    const splitAddress = getAddress(config.receivingAddress);
    const bytecode = await this.evmClient.getBytecode(splitAddress);
    if (!bytecode || bytecode === "0x") {
      throw new PaymentRailMisconfiguredPortError(
        "SPLIT_CONTRACT_MISSING",
        `Payment rail Split contract missing at ${splitAddress}`,
        { splitAddress }
      );
    }

    const expectedHash = this.expectedSplitHash(config);
    let actualHash: unknown;
    try {
      actualHash = await this.evmClient.readContract({
        address: splitAddress,
        abi: splitV2ABI,
        functionName: "splitHash",
        args: [],
      });
    } catch (error) {
      throw new PaymentRailMisconfiguredPortError(
        "PAYMENT_RAIL_CHECK_FAILED",
        "Payment rail Split hash check failed",
        {
          splitAddress,
          error: error instanceof Error ? error.message : String(error),
        }
      );
    }

    if (
      typeof actualHash !== "string" ||
      actualHash.toLowerCase() !== expectedHash.toLowerCase()
    ) {
      throw new PaymentRailMisconfiguredPortError(
        "SPLIT_CONFIG_MISMATCH",
        "Payment rail Split allocation does not match repo-spec economics",
        {
          splitAddress,
          expectedHash,
          actualHash,
          markupFactor: config.markupFactor,
          revenueShare: config.revenueShare,
        }
      );
    }
  }

  private expectedSplitHash(config: PaymentRailGuardConfig): Hex {
    const { operatorAllocation, treasuryAllocation } =
      calculateSplitAllocations(
        numberToPpm(config.markupFactor),
        numberToPpm(config.revenueShare),
        OPENROUTER_CRYPTO_FEE_PPM
      );

    const entries = [
      {
        address: getAddress(this.config.operatorAddress),
        allocation: operatorAllocation,
      },
      {
        address: getAddress(this.config.treasuryAddress),
        allocation: treasuryAllocation,
      },
    ].sort((a, b) =>
      a.address.toLowerCase().localeCompare(b.address.toLowerCase())
    );

    return keccak256(
      encodeAbiParameters(SPLIT_V2_STRUCT_PARAMS, [
        {
          recipients: entries.map((entry) => entry.address as Address),
          allocations: entries.map((entry) => entry.allocation),
          totalAllocation: SPLIT_TOTAL_ALLOCATION,
          distributionIncentive: DISTRIBUTION_INCENTIVE,
        },
      ])
    );
  }
}
