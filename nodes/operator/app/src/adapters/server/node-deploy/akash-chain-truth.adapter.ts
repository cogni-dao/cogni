// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/node-deploy/akash-chain-truth.adapter`
 * Purpose: Independent chain truth for a deployment, read from a public Akash REST node, so the
 *   sequencer can (a) confirm a close without trusting the writer that closed it and (b) see
 *   `insufficient_funds` — a lease the chain closed for lack of escrow (task.5400, rule
 *   `receipt-is-not-liveness`).
 * Scope: Read-only GET of the market lease list for `(owner, dseq)`. No credentials.
 * Invariants:
 *   - LEASE_STATE_IS_THE_TRUTH: `active` iff any lease of the dseq is active; `insufficient_funds` iff
 *     the dseq's leases are insufficient_funds; otherwise `closed`. No lease at all falls back to the
 *     deployment's own state, and an unreadable or absent answer is `unknown`, never `closed`.
 * Side-effects: IO (HTTPS to a public Akash REST endpoint)
 * @internal
 */

import type { ChainTruthPort } from "@/ports";

export interface AkashChainTruthConfig {
  /** The Akash account that owns the deployments (public on-chain address). */
  readonly owner: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

export class AkashChainTruth implements ChainTruthPort {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly cfg: AkashChainTruthConfig) {
    this.base = (cfg.baseUrl ?? "https://api.akashnet.net").replace(/\/+$/, "");
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private async get(path: string): Promise<unknown | undefined> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 404) return undefined;
    if (!res.ok)
      throw new Error(`akash rest ${path.split("?")[0]} -> ${res.status}`);
    return res.json();
  }

  async deploymentState(
    externalName: string
  ): Promise<"active" | "closed" | "insufficient_funds" | "unknown"> {
    if (!/^\d+$/.test(externalName)) return "unknown";
    try {
      const owner = encodeURIComponent(this.cfg.owner);
      const leases = (await this.get(
        `/akash/market/v1beta5/leases/list?filters.owner=${owner}&filters.dseq=${externalName}`
      )) as { leases?: { lease?: { state?: string } }[] } | undefined;
      const states = (leases?.leases ?? []).map((l) => l.lease?.state ?? "");
      if (states.includes("active")) return "active";
      if (states.length > 0)
        return states.every((s) => s === "insufficient_funds")
          ? "insufficient_funds"
          : "closed";
      const dep = (await this.get(
        `/akash/deployment/v1beta4/deployments/info?id.owner=${owner}&id.dseq=${externalName}`
      )) as { deployment?: { state?: string } } | undefined;
      const state = dep?.deployment?.state;
      if (state === "active") return "active";
      if (state === "closed") return "closed";
      return "unknown";
    } catch {
      return "unknown";
    }
  }
}
