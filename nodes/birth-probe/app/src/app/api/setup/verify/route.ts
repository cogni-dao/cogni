// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/setup/verify`
 * Purpose: Server-side verification of DAO formation transactions.
 * Scope: Derives addresses from tx receipts, verifies on-chain state, returns repo-spec YAML; does not modify blockchain state.
 * Invariants: NEVER trusts client-provided addresses; all addresses derived from receipts.
 * Side-effects: IO (RPC reads via viem)
 * Links: docs/spec/node-formation.md, work/projects/proj.chain-deployment-refactor.md
 * @public
 */

import {
  DAO_REGISTERED_EVENT,
  getAragonAddresses,
  INSTALLATION_APPLIED_EVENT,
  type SupportedChainId,
} from "@cogni/aragon-osx";
import { COGNI_SIGNAL_ABI } from "@cogni/cogni-contracts";
import {
  type SetupVerifyOutput,
  setupVerifyOperation,
} from "@cogni/node-contracts";
import {
  CHAINS,
  GOVERNANCE_ERC20_ABI,
  TOKEN_VOTING_ABI,
} from "@cogni/node-shared";
import { NextResponse } from "next/server";
import { v5 as uuidv5 } from "uuid";
import { createPublicClient, http } from "viem";
import { base, sepolia } from "viem/chains";
import { withRootSpan } from "@/bootstrap/otel";
import { serverEnv } from "@/shared/env";
import {
  createRequestContext,
  EVENT_NAMES,
  logEvent,
  makeLogger,
} from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const baseLog = makeLogger();
const clock = { now: () => new Date().toISOString() };

// Map chainId to viem chain object (only BASE and SEPOLIA supported)
const VIEM_CHAINS = {
  [CHAINS.BASE.chainId]: base,
  [CHAINS.SEPOLIA.chainId]: sepolia,
};

function getPublicClient(chainId: SupportedChainId) {
  const chain = VIEM_CHAINS[chainId];
  if (!chain) {
    throw new Error(`Unsupported chainId: ${chainId}`);
  }

  const rpcUrl = serverEnv().EVM_RPC_URL;
  // Hard requirement: no fallback to default RPC
  if (!rpcUrl) {
    throw new Error(
      `EVM_RPC_URL is required for setup verification. chainId=${chainId}`
    );
  }

  return createPublicClient({
    chain,
    transport: http(rpcUrl),
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  return withRootSpan(
    "POST setup.verify",
    { route_id: "setup.verify" },
    async ({ traceId }) => {
      const ctx = createRequestContext({ baseLog, clock }, request, {
        routeId: "setup.verify",
        traceId,
      });
      const startTime = performance.now();

      try {
        const body = await request.json();
        const parseResult = setupVerifyOperation.input.safeParse(body);

        if (!parseResult.success) {
          const response: SetupVerifyOutput = {
            verified: false,
            errors: parseResult.error.issues.map((i) => i.message),
          };
          logEvent(ctx.log, EVENT_NAMES.SETUP_DAO_VERIFY_COMPLETE, {
            reqId: ctx.reqId,
            routeId: ctx.routeId,
            outcome: "error",
            chainId: 0,
            durationMs: Math.round(performance.now() - startTime),
            errorCount: parseResult.error.issues.length,
          });
          return NextResponse.json(response, { status: 400 });
        }

        const {
          chainId,
          daoTxHash,
          signalTxHash,
          signalBlockNumber,
          initialHolder,
        } = parseResult.data;
        const errors: string[] = [];

        const client = getPublicClient(chainId as SupportedChainId);
        const aragonAddresses = getAragonAddresses(chainId);

        // 1. Get DAO creation receipt
        let daoAddress: `0x${string}` | null = null;
        let pluginAddress: `0x${string}` | null = null;

        try {
          const daoReceipt = await client.getTransactionReceipt({
            hash: daoTxHash as `0x${string}`,
          });

          if (daoReceipt.status !== "success") {
            errors.push("DAO creation transaction failed");
          } else {
            // Extract DAO address from DAORegistered event
            // DAORegistered(address indexed dao, address indexed creator, string subdomain)
            for (const log of daoReceipt.logs) {
              if (log.topics[0] === DAO_REGISTERED_EVENT.topic) {
                daoAddress = `0x${log.topics[1]?.slice(26)}` as `0x${string}`;
              }
            }

            // Extract plugin address from InstallationApplied event
            // InstallationApplied(address indexed dao, address indexed plugin, bytes32 preparedSetupId, bytes32 appliedSetupId)
            for (const log of daoReceipt.logs) {
              if (log.topics[0] === INSTALLATION_APPLIED_EVENT.topic) {
                pluginAddress =
                  `0x${log.topics[2]?.slice(26)}` as `0x${string}`;
              }
            }

            // Fallback: find plugin by iterating logs
            if (!pluginAddress && daoReceipt.logs.length > 0) {
              // Plugin is typically emitted in PluginInstalled or similar
              // Use heuristic: address that isn't factory, PSP, or DAO
              for (const log of daoReceipt.logs) {
                const addr = log.address.toLowerCase();
                if (
                  addr !== aragonAddresses.daoFactory.toLowerCase() &&
                  addr !== aragonAddresses.pluginSetupProcessor.toLowerCase() &&
                  addr !== daoAddress?.toLowerCase()
                ) {
                  // Verify it's the TokenVoting plugin by checking getVotingToken
                  try {
                    await client.readContract({
                      address: log.address,
                      abi: TOKEN_VOTING_ABI,
                      functionName: "getVotingToken",
                    });
                    pluginAddress = log.address;
                    break;
                  } catch {
                    // Not the plugin, continue
                  }
                }
              }
            }

            if (!daoAddress) {
              errors.push("Could not extract DAO address from receipt");
            }
            if (!pluginAddress) {
              errors.push("Could not extract plugin address from receipt");
            }
          }
        } catch (err) {
          errors.push(
            `Failed to fetch DAO receipt: ${err instanceof Error ? err.message : "unknown"}`
          );
        }

        // 2. Get token address from plugin
        let tokenAddress: `0x${string}` | null = null;

        if (pluginAddress) {
          try {
            tokenAddress = await client.readContract({
              address: pluginAddress,
              abi: TOKEN_VOTING_ABI,
              functionName: "getVotingToken",
            });
          } catch (err) {
            errors.push(
              `Failed to get voting token: ${err instanceof Error ? err.message : "unknown"}`
            );
          }
        }

        // 3. Verify initial holder balance
        if (tokenAddress) {
          try {
            const balance = await client.readContract({
              address: tokenAddress,
              abi: GOVERNANCE_ERC20_ABI,
              functionName: "balanceOf",
              args: [initialHolder as `0x${string}`],
            });

            if (balance !== 10n ** 18n) {
              errors.push(
                `Initial holder balance mismatch: expected 1e18, got ${balance.toString()}`
              );
            }
          } catch (err) {
            errors.push(
              `Failed to check balance: ${err instanceof Error ? err.message : "unknown"}`
            );
          }
        }

        // 4. Get CogniSignal deployment receipt
        let signalAddress: `0x${string}` | null = null;

        try {
          const signalReceipt = await client.getTransactionReceipt({
            hash: signalTxHash as `0x${string}`,
          });

          if (signalReceipt.status !== "success") {
            errors.push("CogniSignal deployment transaction failed");
          } else if (signalReceipt.contractAddress) {
            signalAddress = signalReceipt.contractAddress;
            ctx.log.info(
              { signalAddress, signalTxHash },
              "setup.verify: extracted signal address"
            );
          } else {
            errors.push("CogniSignal deployment did not create contract");
          }
        } catch (err) {
          errors.push(
            `Failed to fetch signal receipt: ${err instanceof Error ? err.message : "unknown"}`
          );
        }

        // 5. Verify CogniSignal.DAO() == daoAddress
        // Query at signalBlockNumber to avoid cross-RPC race condition
        if (signalAddress && daoAddress) {
          try {
            const blockNumber = BigInt(signalBlockNumber);
            // Verify contract exists at the specific block (avoids "latest" race)
            const bytecode = await client.getBytecode({
              address: signalAddress,
              blockNumber,
            });
            ctx.log.info(
              {
                signalAddress,
                daoAddress,
                signalBlockNumber,
                bytecodeExists: bytecode != null,
                bytecodeLength: bytecode?.length ?? 0,
              },
              "setup.verify: calling CogniSignal.DAO()"
            );

            if (!bytecode) {
              errors.push(
                `CogniSignal contract not found at ${signalAddress} at block ${signalBlockNumber}`
              );
            } else {
              const signalDao = await client.readContract({
                address: signalAddress,
                abi: COGNI_SIGNAL_ABI,
                functionName: "DAO",
                blockNumber,
              });

              if (signalDao.toLowerCase() !== daoAddress.toLowerCase()) {
                errors.push(
                  `CogniSignal.DAO() mismatch: expected ${daoAddress}, got ${signalDao}`
                );
              }
            }
          } catch (err) {
            ctx.log.error(
              {
                signalAddress,
                err: err instanceof Error ? err.message : "unknown",
              },
              "setup.verify: CogniSignal.DAO() call failed"
            );
            errors.push(
              `Failed to verify CogniSignal.DAO(): ${err instanceof Error ? err.message : "unknown"}`
            );
          }
        }

        // 6. Build response
        if (
          errors.length === 0 &&
          daoAddress &&
          tokenAddress &&
          pluginAddress &&
          signalAddress
        ) {
          const repoSpecYaml = buildRepoSpecYaml({
            chainId,
            daoAddress,
            pluginAddress,
            signalAddress,
          });

          const response: SetupVerifyOutput = {
            verified: true,
            addresses: {
              dao: daoAddress,
              token: tokenAddress,
              plugin: pluginAddress,
              signal: signalAddress,
            },
            repoSpecYaml,
          };

          logEvent(ctx.log, EVENT_NAMES.SETUP_DAO_VERIFY_COMPLETE, {
            reqId: ctx.reqId,
            routeId: ctx.routeId,
            outcome: "success",
            chainId,
            durationMs: Math.round(performance.now() - startTime),
            errorCount: 0,
          });
          return NextResponse.json(response);
        }

        const response: SetupVerifyOutput = {
          verified: false,
          errors: errors.length > 0 ? errors : ["Verification incomplete"],
        };

        logEvent(ctx.log, EVENT_NAMES.SETUP_DAO_VERIFY_COMPLETE, {
          reqId: ctx.reqId,
          routeId: ctx.routeId,
          outcome: "error",
          chainId,
          durationMs: Math.round(performance.now() - startTime),
          errorCount: errors.length,
          errors,
        });
        return NextResponse.json(response, { status: 400 });
      } catch (err) {
        const response: SetupVerifyOutput = {
          verified: false,
          errors: [
            err instanceof Error ? err.message : "Internal server error",
          ],
        };
        logEvent(ctx.log, EVENT_NAMES.SETUP_DAO_VERIFY_COMPLETE, {
          reqId: ctx.reqId,
          routeId: ctx.routeId,
          outcome: "error",
          chainId: 0,
          durationMs: Math.round(performance.now() - startTime),
          errorCount: 1,
        });
        return NextResponse.json(response, { status: 500 });
      }
    }
  );
}

function buildRepoSpecYaml(params: {
  chainId: number;
  daoAddress: string;
  pluginAddress: string;
  signalAddress: string;
}): string {
  const nodeId = crypto.randomUUID();
  const scopeId = uuidv5("default", nodeId);

  return `# Generated by Node Formation
# Copy this to .cogni/repo-spec.yaml

schema_version: "0.1.4"

# Unique identity for this node deployment.
# Generated once at init; must never change for an existing deployment.
node_id: "${nodeId}"

# Governance domain. Derived: uuidv5(node_id, "default")
scope_id: "${scopeId}"
scope_key: "default"

cogni_dao:
  dao_contract: "${params.daoAddress}"
  plugin_contract: "${params.pluginAddress}"
  signal_contract: "${params.signalAddress}"
  chain_id: "${params.chainId}"

# Payment rails — activate with: pnpm node:activate-payments
payments:
  status: pending_activation
`;
}
