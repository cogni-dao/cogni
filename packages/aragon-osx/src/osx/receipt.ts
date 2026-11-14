// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/aragon-osx/osx/receipt`
 * Purpose: Strict decoders for Aragon OSx transaction receipts.
 * Scope: Pure decoding; does not make RPC calls. Throws if expected events not found.
 * Invariants: No fallback heuristics. Missing events throw errors.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/node-formation-contract
 * @public
 */

import { decodeEventLog } from "viem";

import type { HexAddress } from "../types";
import {
  DAO_REGISTERED_EVENT,
  INSTALLATION_APPLIED_EVENT,
  OSX_EVENT_ABIS,
} from "./events";

export class ReceiptDecodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiptDecodingError";
  }
}

export interface DaoCreationResult {
  daoAddress: HexAddress;
  pluginAddress: HexAddress;
}

export interface TransactionLog {
  address: HexAddress;
  topics: readonly `0x${string}`[];
  data: `0x${string}`;
}

export interface TransactionReceipt {
  status: "success" | "reverted";
  logs: readonly TransactionLog[];
  contractAddress?: HexAddress | null | undefined;
}

/**
 * Decode DAO address from DAOFactory.createDao receipt.
 * Throws if DAORegistered event not found.
 */
export function decodeDaoAddress(receipt: TransactionReceipt): HexAddress {
  if (receipt.status !== "success") {
    throw new ReceiptDecodingError("Transaction reverted");
  }

  for (const log of receipt.logs) {
    if (log.topics[0] === DAO_REGISTERED_EVENT.topic) {
      try {
        const decoded = decodeEventLog({
          abi: OSX_EVENT_ABIS,
          data: log.data,
          topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
        });

        if (decoded.eventName === "DAORegistered" && decoded.args) {
          const args = decoded.args as { dao: HexAddress };
          return args.dao;
        }
      } catch {
        // Try manual extraction from indexed topic
        if (log.topics[1]) {
          return `0x${log.topics[1].slice(26)}` as HexAddress;
        }
      }
    }
  }

  throw new ReceiptDecodingError(
    "DAORegistered event not found in receipt. Cannot determine DAO address."
  );
}

/**
 * Decode plugin address from DAOFactory.createDao receipt.
 * Throws if InstallationApplied event not found.
 */
export function decodePluginAddress(receipt: TransactionReceipt): HexAddress {
  if (receipt.status !== "success") {
    throw new ReceiptDecodingError("Transaction reverted");
  }

  for (const log of receipt.logs) {
    if (log.topics[0] === INSTALLATION_APPLIED_EVENT.topic) {
      try {
        const decoded = decodeEventLog({
          abi: OSX_EVENT_ABIS,
          data: log.data,
          topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
        });

        if (decoded.eventName === "InstallationApplied" && decoded.args) {
          const args = decoded.args as { plugin: HexAddress };
          return args.plugin;
        }
      } catch {
        // Try manual extraction from indexed topic (plugin is topics[2])
        if (log.topics[2]) {
          return `0x${log.topics[2].slice(26)}` as HexAddress;
        }
      }
    }
  }

  throw new ReceiptDecodingError(
    "InstallationApplied event not found in receipt. Cannot determine plugin address."
  );
}

/**
 * Decode both DAO and plugin addresses from createDao receipt.
 * Throws if either event not found.
 */
export function decodeDaoCreationReceipt(
  receipt: TransactionReceipt
): DaoCreationResult {
  return {
    daoAddress: decodeDaoAddress(receipt),
    pluginAddress: decodePluginAddress(receipt),
  };
}

/**
 * Decode CogniSignal contract address from deployment receipt.
 * Throws if contractAddress not present.
 */
export function decodeSignalDeployment(
  receipt: TransactionReceipt
): HexAddress {
  if (receipt.status !== "success") {
    throw new ReceiptDecodingError("Transaction reverted");
  }

  if (!receipt.contractAddress) {
    throw new ReceiptDecodingError(
      "No contractAddress in receipt. This is not a contract deployment transaction."
    );
  }

  return receipt.contractAddress;
}
