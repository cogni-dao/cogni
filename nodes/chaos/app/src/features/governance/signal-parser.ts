// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/signal-parser`
 * Purpose: Decode CogniAction events from EVM transaction receipt logs and parse repo URLs.
 * Scope: Pure parsing logic — uses viem for ABI decoding, Zod for runtime validation. Does not perform I/O.
 * Invariants: Signal schema validated at parse time. Invalid logs return null (logged, not thrown).
 * Side-effects: none
 * Links: docs/spec/governance-signal-execution.md
 * @public
 */

import {
  type Address,
  decodeAbiParameters,
  decodeEventLog,
  type Hex,
  parseAbi,
} from "viem";

import {
  ACTION_VALUES,
  type RepoRef,
  type Signal,
  signalSchema,
  TARGET_VALUES,
  VCS_VALUES,
} from "./signal-types";

// ---------------------------------------------------------------------------
// CogniSignal ABI (single event)
// ---------------------------------------------------------------------------

export const cogniActionAbi = parseAbi([
  "event CogniAction(address indexed dao,uint256 indexed chainId,string vcs,string repoUrl,string action,string target,string resource,bytes extra,address indexed executor)",
]);

export const COGNI_TOPIC0 =
  "0x7a3cb36f100df6ecbe1f567f9c30dc11d02d5c42851e8fd534675bb303566a03";

// ---------------------------------------------------------------------------
// Signal parser
// ---------------------------------------------------------------------------

/**
 * Parse a CogniAction event log into a typed Signal.
 * Returns null if the log is not a CogniAction event or parsing fails.
 *
 * This is the ONLY function that knows the raw blockchain event structure.
 */
export function parseCogniAction(log: {
  address: Address;
  topics: Hex[];
  data: Hex;
}): Signal | null {
  if (!log?.topics?.[0] || log.topics[0].toLowerCase() !== COGNI_TOPIC0) {
    return null;
  }

  try {
    const { args } = decodeEventLog({
      abi: cogniActionAbi,
      data: log.data,
      topics: log.topics as [Hex, ...Hex[]],
    });

    // Parse extra field: abi.encode(nonce, deadline, paramsJson)
    let nonce = BigInt(0);
    let deadline = 0;
    let paramsJson = "";

    if (args.extra && args.extra !== "0x" && args.extra.length > 2) {
      try {
        const decoded = decodeAbiParameters(
          [
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint64" },
            { name: "paramsJson", type: "string" },
          ],
          args.extra
        );
        nonce = decoded[0];
        deadline = Number(decoded[1]);
        paramsJson = decoded[2];
      } catch {
        // Fall back to defaults — handles legacy events with empty extra
      }
    } else {
      // Empty extra field: set generous deadline for MVP
      deadline = Math.floor(Date.now() / 1000) + 86400;
    }

    const vcsRaw = args.vcs.toLowerCase();
    const action = args.action;
    const target = args.target;

    // Validate enum values
    if (!(VCS_VALUES as readonly string[]).includes(vcsRaw)) return null;
    if (!(ACTION_VALUES as readonly string[]).includes(action)) return null;
    if (!(TARGET_VALUES as readonly string[]).includes(target)) return null;

    // Runtime validate with Zod
    const raw = {
      dao: args.dao,
      chainId: BigInt(args.chainId as unknown as string),
      vcs: vcsRaw,
      repoUrl: args.repoUrl,
      action,
      target,
      resource: args.resource,
      nonce,
      deadline,
      paramsJson,
      executor: args.executor,
    };

    const result = signalSchema.safeParse(raw);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Repo URL parser
// ---------------------------------------------------------------------------

/**
 * Parse a VCS URL into owner/repo components.
 * Supports GitHub, GitLab (with subgroups), and Radicle URLs.
 */
export function parseRepoRef(repoUrl: string): RepoRef {
  const url = new URL(repoUrl);
  const cleanUrl = `${url.protocol}//${url.host}${url.pathname}`.replace(
    /\.git$/,
    ""
  );
  const pathname = url.pathname.slice(1).replace(/\.git$/, "");
  const segments = pathname.split("/").filter((s) => s.length > 0);

  if (segments.length < 2) {
    throw new Error(`Repository URL must contain owner and repo: ${repoUrl}`);
  }

  // Safe: segments.length >= 2 guaranteed by guard above
  const repo = segments.at(-1) as string;
  const owner = segments.slice(0, -1).join("/");

  return { host: url.hostname.toLowerCase(), owner, repo, url: cleanUrl };
}
