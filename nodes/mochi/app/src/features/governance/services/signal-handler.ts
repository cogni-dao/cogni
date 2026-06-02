// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/services/signal-handler`
 * Purpose: Orchestrate on-chain CogniAction signal execution: RPC verify → decode → validate → execute GitHub action.
 * Scope: Top-level signal handler. Dependencies injected — does not import adapters or bootstrap.
 * Invariants:
 * - ON_CHAIN_RE_VERIFY: Signal is re-fetched from RPC, never trusted from webhook payload
 * - TX_HASH_DEDUP: Same tx hash is executed at most once (in-memory Set for crawl)
 * - DAO_CONFIG_FROM_SPEC: chain_id + dao_address validated against repo-spec.yaml
 * Side-effects: IO (EVM RPC read, GitHub API writes via action handlers)
 * Links: docs/spec/governance-signal-execution.md
 * @public
 */

import { EVENT_NAMES } from "@cogni/node-shared";
import type { Octokit } from "@octokit/core";
import type { Logger } from "pino";
import type { Address, Hex, PublicClient } from "viem";

import { resolveAction } from "../actions";
import { COGNI_TOPIC0, parseCogniAction, parseRepoRef } from "../signal-parser";
import type { ActionResult } from "../signal-types";

// ---------------------------------------------------------------------------
// Tx hash dedup (in-memory for crawl — upgrade to DB in Walk phase)
// ---------------------------------------------------------------------------

const executedTxHashes = new Set<string>();

/** Check if tx hash was already executed. */
export function hasTxBeenExecuted(txHash: string): boolean {
  return executedTxHashes.has(txHash.toLowerCase());
}

/** Mark tx hash as executed. */
export function markTxExecuted(txHash: string): void {
  executedTxHashes.add(txHash.toLowerCase());
}

/** Reset dedup set (for testing). */
export function resetTxDedup(): void {
  executedTxHashes.clear();
}

// ---------------------------------------------------------------------------
// Dependencies (injected by caller)
// ---------------------------------------------------------------------------

export interface SignalHandlerDeps {
  /** viem public client for RPC calls */
  readonly rpcClient: PublicClient;
  /** Resolve an authenticated Octokit for the target repo (handles installation lookup internally) */
  readonly resolveOctokit: (owner: string, repo: string) => Promise<Octokit>;
  /** DAO config from repo-spec */
  readonly daoConfig: {
    readonly signal_contract: string;
    readonly dao_contract: string;
    readonly chain_id: string;
  };
  readonly log: Logger;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Execute a governance signal from a transaction hash.
 *
 * 1. Check tx hash dedup
 * 2. Fetch tx receipt from RPC (ON_CHAIN_RE_VERIFY)
 * 3. Find CogniAction event log
 * 4. Parse signal
 * 5. Validate chain_id + dao against repo-spec
 * 6. Validate deadline
 * 7. Resolve action handler
 * 8. Create Octokit for repo installation
 * 9. Execute action
 */
export async function handleSignal(
  txHash: string,
  deps: SignalHandlerDeps
): Promise<ActionResult> {
  const log = deps.log.child({ component: "signal-handler", txHash });

  // 1. Dedup
  if (hasTxBeenExecuted(txHash)) {
    log.info("tx already executed — skipping");
    return {
      success: false,
      action: "duplicate",
      error: "tx already executed",
    };
  }

  try {
    // 2. Fetch receipt from RPC (never trust webhook payload)
    const receipt = await deps.rpcClient.getTransactionReceipt({
      hash: txHash as Hex,
    });

    if (!receipt || receipt.status === "reverted") {
      log.warn("tx reverted or not found");
      return {
        success: false,
        action: "tx_reverted",
        error: "transaction reverted",
      };
    }

    // 3. Find CogniAction log
    const cogniLog = receipt.logs.find(
      (l: { topics: readonly string[]; address: string }) =>
        l.topics[0]?.toLowerCase() === COGNI_TOPIC0 &&
        l.address.toLowerCase() === deps.daoConfig.signal_contract.toLowerCase()
    );

    if (!cogniLog) {
      log.info("no CogniAction event in tx logs");
      return {
        success: false,
        action: "no_signal",
        error: "no CogniAction event found",
      };
    }

    // 4. Parse signal
    const signal = parseCogniAction({
      address: cogniLog.address as Address,
      topics: cogniLog.topics as Hex[],
      data: cogniLog.data as Hex,
    });

    if (!signal) {
      log.warn("failed to parse CogniAction event");
      return {
        success: false,
        action: "parse_failed",
        error: "could not parse signal",
      };
    }

    // 5. Validate chain_id + dao against repo-spec
    if (signal.chainId.toString() !== deps.daoConfig.chain_id) {
      log.warn(
        { expected: deps.daoConfig.chain_id, got: signal.chainId.toString() },
        "chain_id mismatch"
      );
      return {
        success: false,
        action: "chain_mismatch",
        error: "chain_id does not match repo-spec",
      };
    }

    if (
      signal.dao.toLowerCase() !== deps.daoConfig.dao_contract.toLowerCase()
    ) {
      log.warn(
        { expected: deps.daoConfig.dao_contract, got: signal.dao },
        "dao_contract mismatch"
      );
      return {
        success: false,
        action: "dao_mismatch",
        error: "dao_contract does not match repo-spec",
      };
    }

    // 6. Validate deadline
    const now = Math.floor(Date.now() / 1000);
    if (signal.deadline > 0 && now > signal.deadline) {
      log.warn({ deadline: signal.deadline, now }, "signal expired");
      return {
        success: false,
        action: "expired",
        error: "signal deadline has passed",
      };
    }

    // 7. Resolve action handler
    const handler = resolveAction(signal.action, signal.target);
    if (!handler) {
      log.warn(
        { action: signal.action, target: signal.target },
        "unknown action"
      );
      return {
        success: false,
        action: "unknown_action",
        error: `no handler for ${signal.action}:${signal.target}`,
      };
    }

    // Only GitHub VCS supported in crawl
    if (signal.vcs !== "github") {
      return {
        success: false,
        action: "unsupported_vcs",
        error: `VCS ${signal.vcs} not supported`,
      };
    }

    // 8. Resolve Octokit for target repo
    const repoRef = parseRepoRef(signal.repoUrl);
    const octokit = await deps.resolveOctokit(repoRef.owner, repoRef.repo);

    // 9. Execute action
    const result = await handler(signal, repoRef, octokit, log);

    // Mark as executed only on success
    if (result.success) {
      markTxExecuted(txHash);
    }

    log.info(
      {
        event: EVENT_NAMES.SIGNAL_EXECUTION_COMPLETE,
        action: signal.action,
        target: signal.target,
        outcome: result.success ? "success" : "error",
        errorCode: result.success ? undefined : result.action,
      },
      EVENT_NAMES.SIGNAL_EXECUTION_COMPLETE
    );

    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error(
      {
        event: EVENT_NAMES.ADAPTER_EVM_RPC_ERROR,
        errorCode: "execution_error",
      },
      msg
    );
    return { success: false, action: "execution_error", error: msg };
  }
}
