// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/services/signal-dispatch`
 * Purpose: Fire-and-forget dispatch for on-chain signal execution from Alchemy webhooks.
 * Scope: Resolves deps (RPC client, Octokit factory, DAO config) and dispatches signal handling; does not decode signals or execute actions.
 *   Same pattern as dispatchPrReview() — errors logged, never thrown.
 * Invariants: Fire-and-forget — errors logged, never block webhook response.
 * Side-effects: IO (async signal execution)
 * Links: docs/spec/governance-signal-execution.md
 * @public
 */

import { CHAINS, EVENT_NAMES } from "@cogni/node-shared";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/core";
import type { Logger } from "pino";
import { createPublicClient, http } from "viem";
import { base, mainnet, sepolia } from "viem/chains";
import { getDaoConfig } from "@/shared/config";

import { handleSignal } from "./signal-handler";

// Map chain IDs to viem chain definitions
const CHAIN_MAP: Record<
  string,
  Parameters<typeof createPublicClient>[0]["chain"]
> = {
  "1": mainnet,
  [String(CHAINS.SEPOLIA.chainId)]: sepolia,
  [String(CHAINS.BASE.chainId)]: base,
};

/**
 * Dispatch signal execution for all tx hashes in an Alchemy webhook payload.
 * Fire-and-forget — errors are logged, never thrown.
 */
export function dispatchSignalExecution(
  payload: Record<string, unknown>,
  env: {
    GH_REVIEW_APP_ID?: string | undefined;
    GH_REVIEW_APP_PRIVATE_KEY_BASE64?: string | undefined;
    EVM_RPC_URL?: string | undefined;
  },
  log: Logger
): void {
  // Check credentials
  const appId = env.GH_REVIEW_APP_ID;
  const privateKeyBase64 = env.GH_REVIEW_APP_PRIVATE_KEY_BASE64;
  const rpcUrl = env.EVM_RPC_URL;

  if (!appId || !privateKeyBase64) {
    log.debug(
      { event: EVENT_NAMES.SIGNAL_DISPATCH_SKIPPED, reason: "no_github_app" },
      "signal dispatch skipped — GH_REVIEW_APP_ID/PRIVATE_KEY not configured"
    );
    return;
  }

  if (!rpcUrl) {
    log.debug(
      { event: EVENT_NAMES.SIGNAL_DISPATCH_SKIPPED, reason: "no_rpc_url" },
      "signal dispatch skipped — EVM_RPC_URL not configured"
    );
    return;
  }

  // Load DAO config from repo-spec
  const daoConfig = getDaoConfig();
  if (!daoConfig) {
    log.debug(
      { event: EVENT_NAMES.SIGNAL_DISPATCH_SKIPPED, reason: "no_dao_config" },
      "signal dispatch skipped — cogni_dao not configured in repo-spec"
    );
    return;
  }

  // Extract tx hashes from Alchemy payload
  const event = payload.event as Record<string, unknown> | undefined;
  const data = event?.data as Record<string, unknown> | undefined;
  const block = data?.block as Record<string, unknown> | undefined;
  const logs = block?.logs as
    | Array<{ transaction?: { hash?: string } }>
    | undefined;

  if (!logs || logs.length === 0) return;

  const txHashes = new Set<string>();
  for (const logEntry of logs) {
    if (logEntry.transaction?.hash) {
      txHashes.add(logEntry.transaction.hash);
    }
  }

  if (txHashes.size === 0) return;

  // Resolve chain for RPC client
  const chain = CHAIN_MAP[daoConfig.chain_id];

  // Create RPC client
  const rpcClient = createPublicClient({
    ...(chain ? { chain } : {}),
    transport: http(rpcUrl),
  });

  // Pre-decode private key once for all tx hashes
  const privateKey = Buffer.from(privateKeyBase64, "base64").toString("utf-8");

  // Octokit factory: looks up installation ID for the target repo, returns authenticated client
  async function resolveOctokit(owner: string, repo: string): Promise<Octokit> {
    const appOctokit = new Octokit({
      authStrategy: createAppAuth,
      auth: { appId, privateKey },
    });
    const response = await appOctokit.request(
      "GET /repos/{owner}/{repo}/installation",
      { owner, repo }
    );
    const installationId = (response.data as { id: number }).id;
    return new Octokit({
      authStrategy: createAppAuth,
      auth: { appId, privateKey, installationId },
    });
  }

  // Dispatch each tx hash
  for (const txHash of txHashes) {
    void (async () => {
      try {
        await handleSignal(txHash, {
          rpcClient,
          resolveOctokit,
          daoConfig,
          log,
        });
      } catch (error) {
        log.error({ error: String(error), txHash }, "signal dispatch failed");
      }
    })();
  }
}
