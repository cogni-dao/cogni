// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@scripts/experiments/akash-blue-green/lease-audit`
 * Purpose: spike.5001 chain-truth lease snapshot for one Akash wallet. Taken before and after
 *   each measured release so the scorecard can prove "one new lease, old lease closed, no
 *   orphan" from on-chain state rather than from receipts (ledger `allocated` can outlive a
 *   closed deployment).
 * Scope: read-only public Akash REST reads. No credential, no mutation, no deployment policy.
 * Invariants: CHAIN_IS_TRUTH — the snapshot lists only what the chain reports as active.
 * Side-effects: IO (network GETs; stdout JSON).
 * Links: knowledge operator-infra-logs-read (money truth lives on chain), work item spike.5001.
 * @internal — measurement code, not shipped to production
 */

export interface ChainLease {
  readonly dseq: string;
  readonly gseq: number;
  readonly oseq: number;
  readonly provider: string;
  readonly state: string;
  readonly createdAt?: string;
}

export interface LeaseSnapshot {
  readonly at: string;
  readonly owner: string;
  readonly activeDeploymentDseqs: readonly string[];
  readonly activeLeases: readonly ChainLease[];
}

export const DEFAULT_AKASH_REST = "https://api.akashnet.net";

interface DeploymentsList {
  deployments?: { deployment?: { id?: { dseq?: string } } }[];
}
interface LeasesList {
  leases?: {
    lease?: {
      id?: { dseq?: string; gseq?: number; oseq?: number; provider?: string };
      state?: string;
      created_at?: string;
    };
  }[];
}

async function getJson<T>(fetchImpl: typeof fetch, url: string): Promise<T> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function snapshotLeases(
  owner: string,
  opts: { rest?: string; fetchImpl?: typeof fetch; now?: () => Date } = {}
): Promise<LeaseSnapshot> {
  const rest = opts.rest ?? DEFAULT_AKASH_REST;
  const doFetch = opts.fetchImpl ?? fetch;
  const q = `filters.owner=${encodeURIComponent(owner)}&filters.state=active&pagination.limit=1000`;
  const [deps, leases] = await Promise.all([
    getJson<DeploymentsList>(
      doFetch,
      `${rest}/akash/deployment/v1beta4/deployments/list?${q}`
    ),
    getJson<LeasesList>(
      doFetch,
      `${rest}/akash/market/v1beta5/leases/list?${q}`
    ),
  ]);
  return {
    at: (opts.now?.() ?? new Date()).toISOString(),
    owner,
    activeDeploymentDseqs: (deps.deployments ?? [])
      .map((d) => d.deployment?.id?.dseq)
      .filter((d): d is string => typeof d === "string")
      .sort(),
    activeLeases: (leases.leases ?? [])
      .map((l) => ({
        dseq: String(l.lease?.id?.dseq ?? ""),
        gseq: Number(l.lease?.id?.gseq ?? 0),
        oseq: Number(l.lease?.id?.oseq ?? 0),
        provider: String(l.lease?.id?.provider ?? ""),
        state: String(l.lease?.state ?? ""),
        ...(l.lease?.created_at && { createdAt: l.lease.created_at }),
      }))
      .sort((a, b) => a.dseq.localeCompare(b.dseq)),
  };
}

// pnpm tsx scripts/experiments/akash-blue-green/lease-audit.ts <akash-owner-address>
if (import.meta.url === `file://${process.argv[1]}`) {
  const owner = process.argv[2];
  if (!owner?.startsWith("akash1")) {
    console.error("usage: lease-audit.ts <akash1... owner address>");
    process.exit(2);
  }
  snapshotLeases(owner)
    .then((s) => console.log(JSON.stringify(s, null, 2)))
    .catch((e) => {
      console.error(e);
      process.exit(3);
    });
}
