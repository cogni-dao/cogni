// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/lib/proposal-utils`
 * Purpose: Deeplink param validation, gas estimation, and timestamp helpers for proposal creation.
 * Scope: Pure utilities — no React hooks, no state, no I/O beyond gas estimation RPC.
 * Invariants: Param validation returns null on any invalid/missing param.
 * Side-effects: estimateProposalGas performs one RPC call.
 * Links: cogni-proposal-launcher/src/lib/deeplink.ts, cogni-proposal-launcher/src/lib/contractUtils.ts
 * @public
 */

import { CHAINS } from "@cogni/node-shared";
import type { PublicClient } from "viem";

// ---------------------------------------------------------------------------
// Deeplink param validation
// ---------------------------------------------------------------------------

type ParamKind = "addr" | "int" | "str";

const addrRe = /^0x[0-9a-fA-F]{40}$/;
const intRe = /^\d+$/;

export const mergeSpec = {
  dao: "addr",
  plugin: "addr",
  signal: "addr",
  chainId: "int",
  repoUrl: "str",
  pr: "int",
  action: "str",
  target: "str",
} as const satisfies Record<string, ParamKind>;

export type MergeParams = Record<keyof typeof mergeSpec, string>;

/** Allowlist: repoUrl must be a GitHub HTTPS URL. */
const githubUrlRe = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/;

/**
 * Validate URL search params against a spec. Returns typed params or null.
 * repoUrl is additionally validated against a GitHub HTTPS allowlist to prevent XSS.
 */
export function validateDeeplinkParams(
  searchParams: URLSearchParams
): MergeParams | null {
  const out: Record<string, string> = {};

  for (const [key, kind] of Object.entries(mergeSpec)) {
    const raw = searchParams.get(key) ?? "";
    if (!raw) return null;

    const ok =
      kind === "addr"
        ? addrRe.test(raw)
        : kind === "int"
          ? intRe.test(raw)
          : true;

    if (!ok) return null;
    out[key] = raw;
  }

  // Protocol validation: repoUrl must be a GitHub HTTPS URL
  if (!out.repoUrl || !githubUrlRe.test(out.repoUrl)) return null;

  return out as MergeParams;
}

// ---------------------------------------------------------------------------
// Contract helpers
// ---------------------------------------------------------------------------

/**
 * Generate proposal start/end timestamps.
 * Start: now + 60s. End: now + 3 days.
 */
export function generateProposalTimestamps(): {
  startDate: bigint;
  endDate: bigint;
} {
  const now = Math.floor(Date.now() / 1000);
  return {
    startDate: BigInt(now + 60),
    endDate: BigInt(now + 3 * 24 * 3600),
  };
}

/**
 * Estimate gas for proposal creation with 30% safety buffer, capped at 900k.
 */
export async function estimateProposalGas(
  client: PublicClient,
  params: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args: unknown[];
    account: `0x${string}`;
  }
): Promise<bigint> {
  const est = await client.estimateContractGas(params);
  const withBuffer = (est * 13n) / 10n;
  return withBuffer > 900_000n ? 900_000n : withBuffer;
}

// ---------------------------------------------------------------------------
// Chain helpers
// ---------------------------------------------------------------------------

const chainIdToName = new Map(
  Object.values(CHAINS).map((c) => [String(c.chainId), c.key])
);

export function getChainName(chainId: string | number): string {
  return chainIdToName.get(String(chainId)) ?? `Chain ${chainId}`;
}
