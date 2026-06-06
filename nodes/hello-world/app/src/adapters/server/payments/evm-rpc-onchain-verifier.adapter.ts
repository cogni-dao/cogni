// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/payments/evm-rpc-onchain-verifier`
 * Purpose: Direct RPC-based on-chain verifier using EvmOnchainClient for real transaction validation.
 * Scope: Implements OnChainVerifier port with real EVM RPC verification. Does not handle business logic or state transitions.
 * Invariants: Validates caller params against canonical config; requires verified sender/recipient/token/amount; uses MIN_CONFIRMATIONS.
 * Side-effects: IO (via EvmOnchainClient RPC calls)
 * Notes: Production verifier for Phase 3. Replaces PonderOnChainVerifierAdapter stub.
 * Links: docs/spec/payments-design.md, docs/spec/onchain-readers.md
 * @public
 */

import {
  CHAIN_ID,
  MIN_CONFIRMATIONS,
  USDC_TOKEN_ADDRESS,
} from "@cogni/node-shared";
import { getAddress, parseEventLogs } from "viem";
import type {
  OnChainVerifier,
  PaymentErrorCode,
  VerificationResult,
} from "@/ports";
import { getPaymentConfig } from "@/shared/config/repoSpec.server";
import type { EvmOnchainClient } from "@/shared/web3/onchain/evm-onchain-client.interface";

// ERC20 Transfer event ABI for decoding logs
const ERC20_TRANSFER_EVENT = {
  type: "event",
  name: "Transfer",
  inputs: [
    { name: "from", type: "address", indexed: true },
    { name: "to", type: "address", indexed: true },
    { name: "value", type: "uint256", indexed: false },
  ],
} as const;

/**
 * Helper to create a FAILED verification result
 */
function failedResult(errorCode: PaymentErrorCode): VerificationResult {
  return {
    status: "FAILED",
    actualFrom: null,
    actualTo: null,
    actualAmount: null,
    confirmations: null,
    errorCode,
  };
}

/**
 * Helper to create a PENDING verification result
 */
function pendingResult(confirmations?: number): VerificationResult {
  return {
    status: "PENDING",
    actualFrom: null,
    actualTo: null,
    actualAmount: null,
    confirmations: confirmations ?? null,
  };
}

/**
 * EVM RPC-based on-chain verifier for real transaction validation.
 * Validates transactions against canonical config and ERC20 Transfer logs.
 */
export class EvmRpcOnChainVerifierAdapter implements OnChainVerifier {
  constructor(private readonly evmClient: EvmOnchainClient) {}

  async verify(params: {
    chainId: number;
    txHash: string;
    expectedTo: string;
    expectedToken: string;
    expectedAmount: bigint;
  }): Promise<VerificationResult> {
    // 1. Validate caller params against canonical config
    const config = getPaymentConfig();
    if (!config) {
      return failedResult("INVALID_RECIPIENT");
    }
    const canonicalToken = USDC_TOKEN_ADDRESS;

    if (params.chainId !== CHAIN_ID) {
      return failedResult("INVALID_CHAIN");
    }

    // Checksum addresses for comparison
    const expectedToChecksummed = getAddress(params.expectedTo);
    const configReceiverChecksummed = getAddress(config.receivingAddress);

    if (expectedToChecksummed !== configReceiverChecksummed) {
      return failedResult("INVALID_RECIPIENT");
    }

    const expectedTokenChecksummed = getAddress(params.expectedToken);
    const canonicalTokenChecksummed = getAddress(canonicalToken);

    if (expectedTokenChecksummed !== canonicalTokenChecksummed) {
      return failedResult("INVALID_TOKEN");
    }

    // 2. Query chain via EvmOnchainClient
    const txHash = params.txHash as `0x${string}`;

    try {
      // Get transaction - check if it exists
      const tx = await this.evmClient.getTransaction(txHash);
      if (!tx) {
        return failedResult("TX_NOT_FOUND");
      }

      // Get receipt - check if mined
      const receipt = await this.evmClient.getTransactionReceipt(txHash);
      if (!receipt) {
        // Transaction exists but not yet mined
        return pendingResult();
      }

      // Check if reverted
      if (receipt.status === "reverted") {
        return failedResult("TX_REVERTED");
      }

      // 3. Decode ERC20 Transfer logs
      const transferLogs = parseEventLogs({
        abi: [ERC20_TRANSFER_EVENT],
        logs: receipt.logs,
        eventName: "Transfer",
      });

      // Find the Transfer log for our token to our recipient
      const matchingTransfer = transferLogs.find((log) => {
        const logAddress = getAddress(log.address);
        const logTo = getAddress(log.args.to);
        return (
          logAddress === canonicalTokenChecksummed &&
          logTo === configReceiverChecksummed
        );
      });

      if (!matchingTransfer) {
        return failedResult("TOKEN_TRANSFER_NOT_FOUND");
      }

      const actualFrom = getAddress(matchingTransfer.args.from);
      const actualTo = getAddress(matchingTransfer.args.to);
      const actualAmount = matchingTransfer.args.value;

      // 4. Validate transfer params
      if (actualTo !== configReceiverChecksummed) {
        return failedResult("RECIPIENT_MISMATCH");
      }

      if (actualAmount < params.expectedAmount) {
        return failedResult("INSUFFICIENT_AMOUNT");
      }

      // 5. Check confirmations
      const currentBlock = await this.evmClient.getBlockNumber();
      const confirmations = Number(currentBlock - receipt.blockNumber);

      if (confirmations < MIN_CONFIRMATIONS) {
        return {
          status: "PENDING",
          actualFrom,
          actualTo,
          actualAmount,
          confirmations,
        };
      }

      // 6. Return VERIFIED
      return {
        status: "VERIFIED",
        actualFrom,
        actualTo,
        actualAmount,
        confirmations,
      };
    } catch (_error) {
      // RPC errors are returned as RPC_ERROR - caller can log if needed
      return failedResult("RPC_ERROR");
    }
  }
}
