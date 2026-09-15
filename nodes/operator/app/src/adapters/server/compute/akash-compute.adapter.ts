// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/compute/akash-compute.adapter`
 * Purpose: Akash Console API client implementing ComputeResourcePort — balance read over the
 *   managed (USD-billed) Console wallet PLUS the write half: provision a container workload
 *   (create deployment → screen provider bids → lease → prove boot) (task.5044, task.5051).
 * Scope: HTTPS calls to console-api.akash.network with x-api-key auth (+ unauthenticated
 *   /version probes against the leased workload's own ingress). Does NOT hold a Cosmos
 *   key, sign transactions, or settle on-chain — the Console managed wallet bills the shared
 *   operator account in USD (v0 billing model; vNext = per-spawner pass-through + crypto funding).
 * Invariants:
 *   - PROVIDER_AGNOSTIC: SDL, dseq, bids, uakt/uusdc escrow never escape; callers see only
 *     ComputeBalance / ProvisionSpec / ProvisionOutput. `leaseId` IS the dseq but is opaque
 *     to callers by contract.
 *   - ADAPTER_SWAPPABLE: implements the provider-blind ComputeResourcePort next to
 *     CherryComputeAdapter; the factory composes them.
 *   - FAIL_LOUD: HTTP / network / timeout / no-bids / boot-SLO failures throw AkashComputeError
 *     with a stable code so callers and the awareness surface observe their own failures.
 *   - AUDITED_PROVIDERS_ONLY (task.5051): the SDL anchors `signedBy.allOf` to the Overclock
 *     audit account and bids are screened on Console provider data (audited + online +
 *     uptime7d > 0.95 + activeLeases > 0, no 2σ price underbids) — pure logic in
 *     ./akash-provider-screen. Metadata-read failure fails open (signedBy stays the hard gate).
 *   - BOOT_SLO_OR_CLOSE (task.5051): after lease, the workload must serve `/version` and its
 *     fixed `/readyz` health endpoint within `bootSloMs` (default 5min), or the deployment
 *     is closed (escrow refunds) and the provider is recorded as an SLO failure. The
 *     controller begins any later allocation only from a new durable recovery receipt.
 *   - OUTCOME_STORE_IS_ADVISORY: outcome persistence is best-effort — a store failure never
 *     fails a live provision and never blocks screening (empty history).
 * Side-effects: IO (HTTPS requests to the Akash Console API + workload ingress; provision()
 *   spends real escrow; boot outcomes append to Postgres)
 * Links: ComputeResourcePort (@cogni/ai-tools/capabilities/compute), ./akash-sdl,
 *   ./akash-provider-screen, ./provider-outcome-store,
 *   https://akash.network/docs/api-documentation/console-api/ (endpoints verified against
 *   github.com/akash-network/console apps/api routes), knowledge hub
 *   `akash-provider-quality-mandate`, task.5044, task.5051
 * @internal
 */

import type {
  ComputeBalance,
  ComputeResourcePort,
  ProvisionOutput,
  ProvisionSpec,
  ProvisionState,
} from "@cogni/ai-tools";
import type {
  ComputeCostEvidencePort,
  ComputeResourceCostEvidence,
} from "@/ports";
import { makeLogger } from "@/shared/observability";
import {
  type AkashProviderInfo,
  type ProviderOutcomeStats,
  type ScreenableBid,
  screenBids,
} from "./akash-provider-screen";
import { type AkashSdlOptions, buildAkashSdl } from "./akash-sdl";
import type { ProviderOutcomeStore } from "./provider-outcome-store";
import {
  type SafeVersionProbeResult,
  safeReadyzProbe,
  safeVersionProbe,
  safeVersionProbeResult,
} from "./safe-version-probe";

const PROVIDER = "akash";
const MICRO = 1_000_000;

/** Overclock Labs audit account — the `signedBy` anchor Console itself screens on. */
export const AKASH_OVERCLOCK_AUDITOR =
  "akash1365yvmc4s7awdyj3n2sav7xfx76adc6dnmlx63";

/**
 * Country codes treated as co-located with the shared env substrate (EU; the substrate VM
 * lives in Lithuania — app↔substrate latency is real, ~25ms/call from BE). Preference only,
 * never a filter. Coupled to the substrate egress allowlist work (task.5052).
 */
const DEFAULT_SUBSTRATE_COUNTRY_CODES: readonly string[] = [
  "LT",
  "LV",
  "EE",
  "PL",
  "DE",
  "NL",
  "BE",
  "CZ",
  "AT",
  "SK",
  "SE",
  "FI",
  "DK",
  "FR",
  "CH",
];

/** Unauthenticated `/version` probe timeout against the workload's own ingress. */
const PROBE_TIMEOUT_MS = 5_000;

export type BootFailureStage =
  | "status_unavailable"
  | "no_endpoint"
  | "version_unavailable"
  | "source_mismatch"
  | "readiness_unavailable";

export interface AkashComputeAdapterConfig {
  /** Akash Console API key (Settings → API Keys), sent as `x-api-key`. */
  apiKey: string;
  /**
   * Non-secret Akash deployment/escrow consumer pin used only by `observeCost`.
   * Omission keeps legacy read/write compatibility but makes cost evidence fail closed.
   */
  expectedCostConsumerAccountId?: string;
  /** Per-request timeout for reads, in milliseconds. */
  timeoutMs: number;
  /**
   * Timeout for write calls (`/v1/deployments`, `/v1/leases` — on-chain txs that routinely
   * exceed a read budget; an aborted create can orphan a server-side deployment). Default 30s.
   * Also used for the large `/v1/providers` index read.
   */
  writeTimeoutMs?: number;
  /** USD escrow deposited per deployment (Console minimum 0.5). */
  deployDepositUsd?: number;
  /** How long to wait for provider bids before failing, in ms. */
  bidTimeoutMs?: number;
  /** Bid poll interval in ms. */
  bidPollIntervalMs?: number;
  /**
   * Provider addresses to prefer when leasing (e.g. providers whose egress IPs the shared
   * substrate's firewall allowlists). Strongest ranking signal among screened bids; when
   * none of them bid, the best-ranked screened bid is leased.
   */
  preferredProviders?: readonly string[];
  /**
   * Optional operator-owned hard provider boundary. When present, only these
   * provider accounts may be leased; an empty list rejects every bid.
   */
  allowedProviders?: readonly string[];
  /**
   * Country codes ranked as substrate-co-located (latency preference). Defaults to the
   * EU set around the shared substrate.
   */
  preferredCountryCodes?: readonly string[];
  /** Audit-anchor accounts for SDL `signedBy.allOf`. Defaults to the Overclock auditor. */
  auditors?: readonly string[];
  /** Boot SLO: the leased workload must serve `/version` within this window. Default 300s. */
  bootSloMs?: number;
  /** Poll interval while awaiting boot, in ms. Default 10s. */
  bootPollIntervalMs?: number;
  /** Legacy ComputeResourcePort provision sequence bound. The controller does not use it. */
  maxProviderAttempts?: number;
  /** Injected boot-outcome persistence; composition roots choose durable or no-op storage. */
  outcomeStore: ProviderOutcomeStore;
  /**
   * Structural pino subset for advisory-write failures (bug.5128): a
   * compute_provider_outcomes insert failure never fails a live provision, but
   * it must land in logs loudly — silent drops gave provider screening amnesia.
   */
  log?: { error(fields: Record<string, unknown>, message: string): void };
  /** SDL pricing knobs (max price per block per service). */
  pricing?: AkashSdlOptions;
  /** API base URL; defaults to the public Console API. */
  baseUrl?: string;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep for tests; defaults to setTimeout. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Observation clock for exact cost evidence tests. */
  now?: () => Date;
}

/** Console `GET /v1/user/me` (only the field we read). */
interface ConsoleUser {
  id?: string;
}

/** Console `GET /v1/wallets` entry (only the fields we map). */
interface ConsoleWallet {
  id?: number | string;
  address?: string;
  /** Deployment allowance in chain micro-units (uusdc for managed wallets). */
  creditAmount?: number;
  denom?: string;
  isTrialing?: boolean;
}

/** Composite on-chain bid identity — echoed verbatim into the lease call. */
interface ConsoleBidId {
  dseq?: string | number;
  gseq?: number;
  oseq?: number;
  provider?: string;
}

interface ConsoleBid {
  bid?: {
    id?: ConsoleBidId;
    state?: string;
    price?: { denom?: string; amount?: string | number };
  };
}

/** Console `GET /v1/providers` entry (only the quality signals we screen on). */
interface ConsoleProvider {
  owner?: string;
  isAudited?: boolean;
  isOnline?: boolean;
  isValidVersion?: boolean;
  uptime7d?: number;
  leaseCount?: number;
  ipCountryCode?: string | null;
}

interface ConsoleLease {
  id?: ConsoleBidId & { owner?: string };
  state?: string;
  created_at?: string;
  closed_on?: string;
  price?: { denom?: string; amount?: string };
  status?: {
    uris?: string[];
    services?: Record<string, { uris?: string[] }>;
  } | null;
}

interface ConsoleDeploymentDetail {
  deployment?: {
    id?: { owner?: string; dseq?: string | number };
    state?: string;
    created_at?: string;
  };
  leases?: ConsoleLease[];
  escrow_account?: {
    state?: {
      owner?: string;
      state?: string;
      settled_at?: string;
      funds?: { denom?: string; amount?: string }[];
      transferred?: { denom?: string; amount?: string }[];
    };
  };
}

interface ConsoleDeploymentList {
  deployments?: ConsoleDeploymentDetail[];
  pagination?: { hasMore?: boolean; skip?: number; limit?: number };
}

/** Screening inputs loaded once per provision() (both reads are best-effort). */
interface ScreeningContext {
  providers: ReadonlyMap<string, AkashProviderInfo>;
  outcomes: ReadonlyMap<string, ProviderOutcomeStats>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Akash Console compute adapter — read + write halves of ComputeResourcePort over the
 * managed-wallet Console API. One shared account funds every workload (v0 billing).
 */
export class AkashComputeAdapter
  implements ComputeResourcePort, ComputeCostEvidencePort
{
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly writeTimeoutMs: number;
  private readonly deployDepositUsd: number;
  private readonly bidTimeoutMs: number;
  private readonly bidPollIntervalMs: number;
  private readonly bootSloMs: number;
  private readonly bootPollIntervalMs: number;
  private readonly maxProviderAttempts: number;
  private readonly preferredCountryCodes: readonly string[];
  private readonly outcomeStore: ProviderOutcomeStore;
  private readonly log: {
    error(fields: Record<string, unknown>, message: string): void;
  };
  private readonly sdlOptions: AkashSdlOptions;
  private readonly now: () => Date;

  constructor(private readonly config: AkashComputeAdapterConfig) {
    this.baseUrl = (
      config.baseUrl ?? "https://console-api.akash.network"
    ).replace(/\/$/, "");
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.sleep = config.sleepImpl ?? defaultSleep;
    this.writeTimeoutMs = config.writeTimeoutMs ?? 30_000;
    // Default to the Console MINIMUM: idle escrow stays small and trial/thin wallets can
    // deploy (a $5 default 402'd on prod against the $0.50 trial — task.5044). Escrow is a
    // refundable float, not the spend cap; top-ups/auto-reload govern lease lifetime.
    this.deployDepositUsd = config.deployDepositUsd ?? 0.5;
    this.bidTimeoutMs = config.bidTimeoutMs ?? 90_000;
    this.bidPollIntervalMs = config.bidPollIntervalMs ?? 3_000;
    this.bootSloMs = config.bootSloMs ?? 300_000;
    this.bootPollIntervalMs = config.bootPollIntervalMs ?? 10_000;
    this.maxProviderAttempts = config.maxProviderAttempts ?? 3;
    this.preferredCountryCodes =
      config.preferredCountryCodes ?? DEFAULT_SUBSTRATE_COUNTRY_CODES;
    this.outcomeStore = config.outcomeStore;
    this.log = config.log ?? makeLogger({ component: "AkashComputeAdapter" });
    this.now = config.now ?? (() => new Date());
    // uakt ceiling per block per service; managed wallets escrow USD but bid in chain denom.
    // signedBy anchors audited-only screening on-chain (AUDITED_PROVIDERS_ONLY).
    this.sdlOptions = {
      ...(config.pricing ?? { pricingDenom: "uakt", pricingAmount: 10_000 }),
      auditors: config.auditors ?? [AKASH_OVERCLOCK_AUDITOR],
    };
  }

  async balances(): Promise<readonly ComputeBalance[]> {
    const me = await this.request<ConsoleUser>("GET", "/v1/user/me");
    const userId = me?.id;
    if (!userId) {
      throw new AkashComputeError(
        "UNEXPECTED_SHAPE",
        "Console /v1/user/me returned no user id"
      );
    }
    const wallets = await this.request<ConsoleWallet[]>(
      "GET",
      `/v1/wallets?userId=${encodeURIComponent(userId)}`
    );
    const asOf = new Date().toISOString();
    return (wallets ?? []).map((wallet) => ({
      provider: PROVIDER,
      accountId: String(wallet.address ?? wallet.id ?? "unknown"),
      // Managed wallets denominate the allowance in USD micro-units (`uact`/`uusdc`); a
      // self-custody `uakt` allowance is AKT. Any other denom is surfaced verbatim rather
      // than silently mislabeled as USD.
      currency: currencyForDenom(wallet.denom),
      remaining: Number(wallet.creditAmount ?? 0) / MICRO,
      asOf,
      estimatedDaysRemaining: null,
    }));
  }

  /**
   * Legacy ComputeResourcePort compatibility path. The controller never calls this method;
   * it uses provisionWithAllocation so every allocation/recovery has its own durable receipt.
   */
  async provision(p: {
    env: string;
    spec: ProvisionSpec;
  }): Promise<ProvisionOutput> {
    const sdl = buildAkashSdl(p.spec, this.sdlOptions);
    const screening = await this.loadScreeningContext();
    const tried = new Set<string>();
    let finalBootFailureStage: BootFailureStage = "status_unavailable";
    for (let attempt = 1; attempt <= this.maxProviderAttempts; attempt++) {
      const result = await this.provisionOnce(
        sdl,
        p.spec.name,
        undefined,
        screening,
        tried
      );
      if (result.kind === "ok") return result.output;
      finalBootFailureStage = result.stage;
      if (!isProviderAttributableBootFailure(result.stage)) break;
      // slo_failed: provider recorded + excluded; loop to redeploy on the next one.
    }
    throw new AkashComputeError(
      "BOOT_SLO_TIMEOUT",
      `workload failed boot proof within ${this.bootSloMs}ms on ${tried.size} screened provider(s) ` +
        `[${[...tried].join(", ")}]; giving up after ${this.maxProviderAttempts} attempts ` +
        "(deployments closed, escrow refunding)",
      undefined,
      finalBootFailureStage
    );
  }

  /**
   * Controller-owned create: allocate exactly one dseq, durably publish it, then converge.
   * Provider retries belong to the level reconciler so every paid allocation has a receipt.
   */
  async provisionWithAllocation(
    p: {
      env: string;
      spec: ProvisionSpec;
      expectedSourceSha: string;
      idempotencyKey: string;
    },
    onAllocated: (resource: ProvisionOutput) => Promise<void>
  ): Promise<ProvisionOutput> {
    void p.env;
    void p.idempotencyKey;
    const sdl = buildAkashSdl(p.spec, this.sdlOptions);
    const result = await this.provisionOnce(
      sdl,
      p.spec.name,
      p.expectedSourceSha,
      await this.loadScreeningContext(),
      new Set<string>(),
      onAllocated
    );
    if (result.kind === "ok") return result.output;
    throw new AkashComputeError(
      "BOOT_SLO_TIMEOUT",
      "allocated workload did not satisfy the boot SLO and was closed",
      undefined,
      result.stage
    );
  }

  /** Opaque high-water mark used to recover an allocation whose POST response was lost. */
  async allocationCursor(): Promise<string> {
    const deployments = await this.listAllDeployments();
    let max = -1n;
    for (const item of deployments) {
      const raw = item.deployment?.id?.dseq;
      if (raw === undefined || !/^\d+$/.test(String(raw))) continue;
      const value = BigInt(String(raw));
      if (value > max) max = value;
    }
    return max.toString();
  }

  /**
   * Adopt only a unique post-baseline allocation. The controller is the sole wallet writer;
   * manual/route writes invalidate proof and intentionally force fail-closed ambiguity.
   */
  async findAllocationSince(cursor: string): Promise<ProvisionOutput | null> {
    if (!/^-?\d+$/.test(cursor)) {
      throw new AkashComputeError(
        "UNEXPECTED_SHAPE",
        "invalid allocation cursor"
      );
    }
    const baseline = BigInt(cursor);
    const candidates = (await this.listAllDeployments())
      .map((item) => item.deployment?.id?.dseq)
      .filter(
        (value): value is string | number =>
          value !== undefined && /^\d+$/.test(String(value))
      )
      .map((value) => String(value))
      .filter((value) => BigInt(value) > baseline);
    const unique = [...new Set(candidates)];
    if (unique.length === 0) return null;
    if (unique.length > 1) {
      throw new AkashComputeError(
        "AMBIGUOUS_ADOPTION",
        "multiple post-baseline deployments prevent deterministic adoption"
      );
    }
    return this.status({ leaseId: unique[0] as string });
  }

  async status(p: { leaseId: string }): Promise<ProvisionOutput> {
    const detail = await this.request<ConsoleDeploymentDetail>(
      "GET",
      `/v1/deployments/${encodeURIComponent(p.leaseId)}`
    );
    return provisionOutputFromDetail(p.leaseId, detail);
  }

  /** Exact chain-native cost evidence. No fiat conversion or payer inference occurs here. */
  async observeCost(input: {
    resourceId: string;
  }): Promise<ComputeResourceCostEvidence> {
    const detail = await this.request<ConsoleDeploymentDetail>(
      "GET",
      `/v1/deployments/${encodeURIComponent(input.resourceId)}`
    );
    return costEvidenceFromDetail(
      input.resourceId,
      detail,
      this.now(),
      this.config.expectedCostConsumerAccountId
    );
  }

  /** Update an existing deployment in place; Console keeps the same opaque resource id. */
  async update(p: {
    resourceId: string;
    env: string;
    spec: ProvisionSpec;
    expectedSourceSha: string;
    idempotencyKey: string;
  }): Promise<ProvisionOutput> {
    // Console exposes no idempotency-key field. The controller persists this key before IO
    // and blocks replay on an unknown outcome; known-handle PUT itself is idempotent.
    void p.env;
    void p.idempotencyKey;
    await this.updateAllocated({ resourceId: p.resourceId, spec: p.spec });
    return this.awaitBootServing(p.resourceId, p.expectedSourceSha);
  }

  /**
   * In-place SDL replacement on a handle we already own. Spends no new escrow and mints no
   * new handle, so it needs no allocation receipt — the PUT is idempotent by construction.
   * Returns as soon as Console accepts it; convergence is the caller's level problem.
   */
  async updateAllocated(p: {
    resourceId: string;
    spec: ProvisionSpec;
  }): Promise<void> {
    const sdl = buildAkashSdl(p.spec, this.sdlOptions);
    await this.request<ConsoleDeploymentDetail>(
      "PUT",
      `/v1/deployments/${encodeURIComponent(p.resourceId)}`,
      { data: { sdl } },
      this.writeTimeoutMs
    );
  }

  async release(p: { leaseId: string }): Promise<void> {
    await this.request(
      "DELETE",
      `/v1/deployments/${encodeURIComponent(p.leaseId)}`,
      undefined,
      this.writeTimeoutMs
    );
  }

  private async listAllDeployments(): Promise<ConsoleDeploymentDetail[]> {
    const deployments: ConsoleDeploymentDetail[] = [];
    const limit = 1_000;
    for (let skip = 0; ; skip += limit) {
      const page = await this.request<ConsoleDeploymentList>(
        "GET",
        `/v1/deployments?skip=${skip}&limit=${limit}`,
        undefined,
        this.writeTimeoutMs
      );
      deployments.push(...(page?.deployments ?? []));
      if (!page?.pagination?.hasMore) return deployments;
    }
  }

  /**
   * One create→screen→lease→boot-SLO pass. Terminal failures (no bids, HTTP errors) close
   * the deployment and throw dseq-tagged; an SLO miss closes + records and returns
   * `slo_failed` so the caller can retry the next provider.
   */
  private async provisionOnce(
    sdl: string,
    workload: string,
    expectedSourceSha: string | undefined,
    screening: ScreeningContext,
    tried: Set<string>,
    onAllocated?: (resource: ProvisionOutput) => Promise<void>
  ): Promise<
    | { kind: "ok"; output: ProvisionOutput }
    | { kind: "slo_failed"; stage: BootFailureStage }
  > {
    const { dseq, provider } = await this.createAndLease(
      sdl,
      screening,
      tried,
      onAllocated
    );

    // Boot SLO: the lease is paying from here — the workload must PROVE registry egress by
    // serving /version plus fixed /readyz before the deadline, or the lease closes.
    // Only provider-attributable endpoint/version failures count against the provider.
    const leasedAt = Date.now();
    try {
      const output = await this.awaitBootServing(
        String(dseq),
        expectedSourceSha
      );
      await this.recordOutcome({
        computeProvider: PROVIDER,
        providerAccount: provider,
        outcome: "boot_ok",
        leaseId: String(dseq),
        workload,
        bootSeconds: Math.round((Date.now() - leasedAt) / 1000),
      });
      return { kind: "ok", output };
    } catch (error) {
      if (
        error instanceof AkashComputeError &&
        error.code === "BOOT_SLO_TIMEOUT"
      ) {
        await this.release({ leaseId: String(dseq) }).catch(() => {
          // best-effort close; the SLO strike below is what must land
        });
        const stage = error.bootFailureStage ?? "status_unavailable";
        if (isProviderAttributableBootFailure(stage)) {
          await this.recordOutcome({
            computeProvider: PROVIDER,
            providerAccount: provider,
            outcome: "slo_timeout",
            leaseId: String(dseq),
            workload,
            detail: `boot proof incomplete within ${this.bootSloMs}ms`,
          });
          tried.add(provider);
        }
        return {
          kind: "slo_failed",
          stage,
        };
      }
      throw error;
    }
  }

  /**
   * The irreducible paid transaction: create the deployment (escrow opens), publish the
   * allocated handle through `onAllocated` BEFORE any further IO, screen bids, and lease.
   * Returns as soon as the lease exists — boot convergence is the caller's level problem
   * (task.5095: Crossplane owns retry/backoff/readiness; this call owns only the tx).
   */
  async allocateAndLease(p: {
    spec: ProvisionSpec;
    /**
     * Durably publish the allocated handle. A throw here closes the deployment: an
     * unrecorded dseq is a paid lease nobody can ever find.
     */
    onAllocated?: (leaseId: string) => Promise<void>;
  }): Promise<{ leaseId: string; providerAccount: string }> {
    const sdl = buildAkashSdl(p.spec, this.sdlOptions);
    const { dseq, provider } = await this.createAndLease(
      sdl,
      await this.loadScreeningContext(),
      new Set<string>(),
      p.onAllocated
        ? async (resource) => {
            await p.onAllocated?.(resource.leaseId);
          }
        : undefined
    );
    return { leaseId: String(dseq), providerAccount: provider };
  }

  /**
   * Create → publish handle → screen → lease. Every failure after the dseq exists closes
   * the deployment (escrow refunds) and names the dseq; a lost response leaves the
   * deployment findable from the caller's pre-POST cursor (findAllocationSince).
   */
  private async createAndLease(
    sdl: string,
    screening: ScreeningContext,
    tried: Set<string>,
    onAllocated?: (resource: ProvisionOutput) => Promise<void>
  ): Promise<{ dseq: string; provider: string }> {
    const created = await this.request<{ dseq?: string; manifest?: unknown }>(
      "POST",
      "/v1/deployments",
      { data: { sdl, deposit: this.deployDepositUsd } },
      this.writeTimeoutMs
    );
    const dseq = created?.dseq;
    if (!dseq) {
      throw new AkashComputeError(
        "UNEXPECTED_SHAPE",
        "Console POST /v1/deployments returned no dseq"
      );
    }

    if (onAllocated) {
      try {
        await onAllocated({
          provider: PROVIDER,
          leaseId: String(dseq),
          state: "pending",
          endpoints: [],
        });
      } catch {
        await this.release({ leaseId: String(dseq) }).catch(() => {});
        throw new AkashComputeError(
          "UNEXPECTED_SHAPE",
          "controller could not persist the allocated deployment handle; deployment closed"
        );
      }
    }

    // A dseq means the deployment (and its escrow) exists on-chain — never strand it: from
    // here every failure path (missing manifest, no bids, lease error, SLO miss) closes the
    // deployment (refunding escrow), and every error names the dseq.
    let provider: string;
    try {
      if (created?.manifest === undefined) {
        throw new AkashComputeError(
          "UNEXPECTED_SHAPE",
          "Console POST /v1/deployments returned no manifest"
        );
      }
      const bid = await this.awaitScreenedBid(dseq, screening, tried);
      provider = String(bid.provider);
      await this.request(
        "POST",
        "/v1/leases",
        {
          manifest: created.manifest,
          leases: [
            {
              dseq: String(bid.dseq ?? dseq),
              gseq: bid.gseq ?? 1,
              oseq: bid.oseq ?? 1,
              provider: bid.provider,
            },
          ],
        },
        this.writeTimeoutMs
      );
    } catch (error) {
      await this.release({ leaseId: String(dseq) }).catch(() => {
        // best-effort close; the original error (now dseq-tagged) is the one that matters
      });
      if (error instanceof AkashComputeError) {
        throw new AkashComputeError(
          error.code,
          `${error.message} (deployment ${dseq} closed, escrow refunding)`
        );
      }
      throw error;
    }

    return { dseq: String(dseq), provider };
  }

  /**
   * Poll `/v1/bids`, screen each wave (quality filter + blacklist + price-outlier + ranking
   * in ./akash-provider-screen), and pick a provider. A preferred provider
   * that passes screening leases immediately; otherwise the window runs out and the
   * best-ranked screened bid wins. NO_BIDS when zero bids ever arrive; NO_ELIGIBLE_BIDS when
   * bids arrived but screening rejected them all.
   */
  private async awaitScreenedBid(
    dseq: string,
    screening: ScreeningContext,
    tried: ReadonlySet<string>
  ): Promise<ConsoleBidId> {
    const deadline = Date.now() + this.bidTimeoutMs;
    const preferred = this.config.preferredProviders ?? [];
    const allowed = this.config.allowedProviders
      ? new Set(this.config.allowedProviders)
      : undefined;
    let sawAnyBid = false;
    for (;;) {
      const bids = await this.request<ConsoleBid[]>(
        "GET",
        `/v1/bids?dseq=${encodeURIComponent(dseq)}`
      );
      const open = (bids ?? []).filter(
        (b) => b.bid?.id?.provider && (b.bid?.state ?? "open") === "open"
      );
      sawAnyBid = sawAnyBid || open.length > 0;
      const byProvider = new Map<string, ConsoleBidId>();
      const screenable: ScreenableBid[] = [];
      for (const b of open) {
        const id = b.bid?.id;
        const owner = id?.provider;
        if (!id || !owner) continue;
        byProvider.set(owner, id);
        screenable.push({
          provider: owner,
          priceAmount: Number(b.bid?.price?.amount ?? Number.POSITIVE_INFINITY),
        });
      }
      const ranked = screenBids({
        bids: allowed
          ? screenable.filter((bid) => allowed.has(bid.provider))
          : screenable,
        providers: screening.providers,
        outcomes: screening.outcomes,
        preferredProviders: preferred,
        preferredCountryCodes: this.preferredCountryCodes,
        excludedProviders: tried,
        nowMs: Date.now(),
      });
      const best = ranked[0];
      // A preferred provider that survived screening wins immediately; anyone else
      // waits out the window so late (often better) bids can compete.
      if (best && preferred.includes(best.provider)) {
        const id = byProvider.get(best.provider);
        if (id) return id;
      }
      if (Date.now() >= deadline) {
        if (best) {
          const id = byProvider.get(best.provider);
          if (id) return id;
        }
        if (sawAnyBid) {
          throw new AkashComputeError(
            "NO_ELIGIBLE_BIDS",
            `bids arrived for dseq ${dseq} but none passed provider screening ` +
              "(audited + online + uptime7d > 0.95 + active leases, no blacklist, no 2σ underbids)"
          );
        }
        throw new AkashComputeError(
          "NO_BIDS",
          `no provider bids for dseq ${dseq} within ${this.bidTimeoutMs}ms`
        );
      }
      await this.sleep(this.bidPollIntervalMs);
    }
  }

  /**
   * Hold the boot SLO: poll deployment status and require one endpoint to serve `/version`
   * plus fixed `/readyz`. Status/probe failures are tolerated inside the window;
   * the deadline is the arbiter.
   */
  private async awaitBootServing(
    dseq: string,
    expectedSourceSha: string | undefined
  ): Promise<ProvisionOutput> {
    const deadline = Date.now() + this.bootSloMs;
    let failureStage: BootFailureStage = "status_unavailable";
    for (;;) {
      const output = await this.status({ leaseId: dseq }).catch(() => null);
      if (output) {
        if (output.endpoints.length === 0) {
          failureStage = furtherBootStage(failureStage, "no_endpoint");
        } else {
          failureStage = furtherBootStage(failureStage, "version_unavailable");
        }
        for (const endpoint of output.endpoints) {
          const version = await this.probeVersion(endpoint, expectedSourceSha);
          if (version === "version_unavailable") continue;
          if (version === "source_mismatch") {
            failureStage = furtherBootStage(failureStage, "source_mismatch");
            continue;
          }
          failureStage = furtherBootStage(
            failureStage,
            "readiness_unavailable"
          );
          if (await this.probeReadiness(endpoint)) return output;
        }
      }
      if (Date.now() >= deadline) {
        throw new AkashComputeError(
          "BOOT_SLO_TIMEOUT",
          `deployment ${dseq} failed boot proof within ${this.bootSloMs}ms`,
          undefined,
          failureStage
        );
      }
      await this.sleep(this.bootPollIntervalMs);
    }
  }

  /** Unauthenticated bounded source-identity check against workload `/version`. */
  private async probeVersion(
    endpoint: string,
    expectedSourceSha: string | undefined
  ): Promise<SafeVersionProbeResult> {
    if (!this.config.fetchImpl) {
      if (expectedSourceSha)
        return safeVersionProbeResult(endpoint, expectedSourceSha);
      return (await safeVersionProbe(endpoint))
        ? "matched"
        : "version_unavailable";
    }
    const base = endpoint.startsWith("http") ? endpoint : `http://${endpoint}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(
        `${base.replace(/\/$/, "")}/version`,
        { method: "GET", signal: controller.signal }
      );
      if (!response.ok) return "version_unavailable";
      if (!expectedSourceSha) {
        await response.body?.cancel().catch(() => {});
        return "matched";
      }
      const version = (await response.json().catch(() => undefined)) as
        | { buildSha?: unknown }
        | undefined;
      if (typeof version?.buildSha !== "string") return "version_unavailable";
      return version.buildSha === expectedSourceSha
        ? "matched"
        : "source_mismatch";
    } catch {
      return "version_unavailable";
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Unauthenticated bounded GET of the platform-standard `/readyz`. */
  private async probeReadiness(endpoint: string): Promise<boolean> {
    if (!this.config.fetchImpl) return safeReadyzProbe(endpoint);
    const base = endpoint.startsWith("http") ? endpoint : `http://${endpoint}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const url = new URL(base);
      url.pathname = "/readyz";
      url.search = "";
      url.hash = "";
      const response = await this.fetchImpl(url.toString(), {
        method: "GET",
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Load provider metadata + outcome history, each best-effort (advisory inputs only). */
  private async loadScreeningContext(): Promise<ScreeningContext> {
    const providers = new Map<string, AkashProviderInfo>();
    const list = await this.request<ConsoleProvider[]>(
      "GET",
      "/v1/providers",
      undefined,
      this.writeTimeoutMs // the provider index is large; read budget is too tight
    ).catch(() => undefined);
    for (const p of list ?? []) {
      if (!p.owner) continue;
      providers.set(p.owner, {
        owner: p.owner,
        isAudited: p.isAudited === true,
        isOnline: p.isOnline === true,
        isValidVersion: p.isValidVersion === true,
        uptime7d: Number(p.uptime7d ?? 0),
        activeLeases: Number(p.leaseCount ?? 0),
        countryCode: p.ipCountryCode ?? null,
      });
    }
    const outcomes = await this.outcomeStore
      .stats(PROVIDER)
      .catch(() => new Map<string, ProviderOutcomeStats>());
    return { providers, outcomes };
  }

  /** Best-effort outcome append (OUTCOME_STORE_IS_ADVISORY). */
  private async recordOutcome(
    rec: Parameters<ProviderOutcomeStore["record"]>[0]
  ): Promise<void> {
    await this.outcomeStore.record(rec).catch((error: unknown) => {
      // advisory: a history-write failure must never fail a live provision —
      // but it must be visible, or provider screening silently loses its
      // history and re-leases known-bad providers (bug.5128).
      this.log.error(
        {
          reason: "ProviderOutcomeWriteFailed",
          computeProvider: rec.computeProvider,
          providerAccount: rec.providerAccount,
          outcome: rec.outcome,
          ...(rec.leaseId ? { leaseId: rec.leaseId } : {}),
          ...(rec.workload ? { workload: rec.workload } : {}),
          causeType: error instanceof Error ? error.name : "unknown",
          causeMessage:
            error instanceof Error ? error.message : "unknown cause",
        },
        "compute_provider_outcome_write_failed"
      );
    });
  }

  /** Single Console API request with x-api-key auth, timeout, and `data`-envelope unwrap. */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutOverrideMs?: number
  ): Promise<T | undefined> {
    const timeoutMs = timeoutOverrideMs ?? this.config.timeoutMs;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "x-api-key": this.config.apiKey,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      if (!response.ok) {
        // Never retain provider bodies: they can echo the SDL and future resolved secrets.
        await response.body?.cancel().catch(() => {});
        throw new AkashComputeError(
          "HTTP_ERROR",
          `Console request failed with HTTP ${response.status}`,
          response.status
        );
      }
      const json = (await response.json().catch(() => undefined)) as
        | { data?: T }
        | T
        | undefined;
      if (json && typeof json === "object" && "data" in json) {
        return (json as { data?: T }).data;
      }
      return json as T | undefined;
    } catch (error) {
      if (error instanceof AkashComputeError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new AkashComputeError(
          "TIMEOUT",
          `Console ${method} ${path} timeout after ${timeoutMs}ms`
        );
      }
      throw new AkashComputeError(
        "NETWORK_ERROR",
        "Console network request failed"
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

function currencyForDenom(denom: string | undefined): string {
  if (denom === "uakt") return "AKT";
  if (denom === undefined || denom === "uact" || denom === "uusdc")
    return "USD";
  return denom; // unknown chain denom: label honestly, never pretend USD
}

function mapState(
  deploymentState: string | undefined,
  leases: ConsoleLease[]
): ProvisionState {
  if (deploymentState === "closed") return "closed";
  if (leases.some((lease) => lease.state === "active")) return "active";
  if (deploymentState === "active") return "pending"; // deployment open, lease not active yet
  return deploymentState === undefined ? "unknown" : "pending";
}

export type AkashComputeErrorCode =
  | "HTTP_ERROR"
  | "UNEXPECTED_SHAPE"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "NO_BIDS"
  | "NO_ELIGIBLE_BIDS"
  | "BOOT_SLO_TIMEOUT"
  | "AMBIGUOUS_ADOPTION";

/** Stable error codes for the Akash Console path. */
export class AkashComputeError extends Error {
  constructor(
    public readonly code: AkashComputeErrorCode,
    message: string,
    public readonly httpStatus?: number,
    public readonly bootFailureStage?: BootFailureStage
  ) {
    super(message);
    this.name = "AkashComputeError";
  }
}

const BOOT_STAGE_ORDER: Readonly<Record<BootFailureStage, number>> = {
  status_unavailable: 0,
  no_endpoint: 1,
  version_unavailable: 2,
  source_mismatch: 3,
  readiness_unavailable: 4,
};

function isProviderAttributableBootFailure(stage: BootFailureStage): boolean {
  return stage === "no_endpoint" || stage === "version_unavailable";
}

function furtherBootStage(
  current: BootFailureStage,
  observed: BootFailureStage
): BootFailureStage {
  return BOOT_STAGE_ORDER[observed] > BOOT_STAGE_ORDER[current]
    ? observed
    : current;
}

function provisionOutputFromDetail(
  resourceId: string,
  detail: ConsoleDeploymentDetail | undefined
): ProvisionOutput {
  const leases = detail?.leases ?? [];
  const endpoints = leases.flatMap((lease) => {
    const direct = lease.status?.uris ?? [];
    const perService = Object.values(lease.status?.services ?? {}).flatMap(
      (svc) => svc.uris ?? []
    );
    return [...direct, ...perService];
  });
  return {
    provider: PROVIDER,
    leaseId: resourceId,
    state: mapState(detail?.deployment?.state, leases),
    endpoints: [...new Set(endpoints)],
  };
}

const MAX_PROVIDER_TEXT_LENGTH = 512;
const MAX_CHAIN_POSITION_LENGTH = 64;
const MAX_NATIVE_VALUE_LENGTH = 128;
const MAX_NATIVE_AMOUNTS = 32;

function hasAsciiControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function requiredText(
  value: unknown,
  field: string,
  maxLength = MAX_PROVIDER_TEXT_LENGTH
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AkashComputeError(
      "UNEXPECTED_SHAPE",
      `Console deployment cost response omitted ${field}`
    );
  }
  const raw = value;
  if (raw.length > maxLength) {
    throw new AkashComputeError(
      "UNEXPECTED_SHAPE",
      `Console deployment cost response returned oversized ${field}`
    );
  }
  if (/\s/u.test(raw) || hasAsciiControl(raw)) {
    throw new AkashComputeError(
      "UNEXPECTED_SHAPE",
      `Console deployment cost response returned invalid ${field}`
    );
  }
  return raw;
}

function requiredNativeDecimal(
  value: unknown,
  field: string,
  allowNegative = false
): string {
  const raw = requiredText(value, field, MAX_NATIVE_VALUE_LENGTH);
  const pattern = allowNegative
    ? /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/
    : /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
  if (!pattern.test(raw)) {
    throw new AkashComputeError(
      "UNEXPECTED_SHAPE",
      `Console deployment cost response returned invalid ${field}`
    );
  }
  return raw;
}

function requiredDenom(value: unknown, field: string): string {
  const raw = requiredText(value, field, MAX_NATIVE_VALUE_LENGTH);
  if (!/^[A-Za-z0-9][A-Za-z0-9/._:-]*$/.test(raw)) {
    throw new AkashComputeError(
      "UNEXPECTED_SHAPE",
      `Console deployment cost response returned invalid ${field}`
    );
  }
  return raw;
}

function chainPosition(
  value: unknown,
  field: string,
  zeroMeansAbsent = false
): string | undefined {
  if (
    zeroMeansAbsent &&
    (value === undefined || value === "" || value === "0")
  ) {
    return undefined;
  }
  const raw = requiredText(value, field, MAX_CHAIN_POSITION_LENGTH);
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new AkashComputeError(
      "UNEXPECTED_SHAPE",
      `Console deployment cost response returned invalid ${field}`
    );
  }
  return raw;
}

function nativeAmounts(
  values: readonly { denom?: string; amount?: string }[] | undefined,
  field: string,
  allowNegative = false
): readonly { denom: string; amount: string }[] {
  if (!values) {
    throw new AkashComputeError(
      "UNEXPECTED_SHAPE",
      `Console deployment cost response omitted ${field}`
    );
  }
  if (values.length > MAX_NATIVE_AMOUNTS) {
    throw new AkashComputeError(
      "UNEXPECTED_SHAPE",
      `Console deployment cost response returned too many ${field}`
    );
  }
  const seen = new Set<string>();
  return values.map((value, index) => {
    const denom = requiredDenom(value.denom, `${field}[${index}].denom`);
    if (seen.has(denom)) {
      throw new AkashComputeError(
        "UNEXPECTED_SHAPE",
        `Console deployment cost response duplicated ${field} denomination`
      );
    }
    seen.add(denom);
    const amount = requiredNativeDecimal(
      value.amount,
      `${field}[${index}].amount`,
      allowNegative
    );
    return { denom, amount };
  });
}

/** Map Console's chain-shaped deployment response into exact provider-neutral evidence. */
function costEvidenceFromDetail(
  resourceId: string,
  detail: ConsoleDeploymentDetail | undefined,
  observedAt: Date,
  expectedConsumerAccountId: string | undefined
): ComputeResourceCostEvidence {
  const deployment = detail?.deployment;
  const deploymentId = String(deployment?.id?.dseq ?? "");
  if (!deployment || deploymentId !== resourceId) {
    throw new AkashComputeError(
      "UNEXPECTED_SHAPE",
      "Console deployment cost response did not match the requested resource"
    );
  }
  const leases = detail.leases ?? [];
  const active = leases.filter((lease) => lease.state === "active");
  const lease =
    active.length === 1
      ? active[0]
      : leases.length === 1
        ? leases[0]
        : undefined;
  if (!lease) {
    throw new AkashComputeError(
      "UNEXPECTED_SHAPE",
      "Console deployment cost response did not identify exactly one lease"
    );
  }
  if (String(lease.id?.dseq ?? "") !== resourceId) {
    throw new AkashComputeError(
      "UNEXPECTED_SHAPE",
      "Console lease cost response did not match the requested resource"
    );
  }
  const consumer = requiredText(deployment.id?.owner, "deployment.id.owner");
  const expectedConsumer = requiredText(
    expectedConsumerAccountId,
    "expected cost consumer account"
  );
  if (consumer !== expectedConsumer) {
    throw new AkashComputeError(
      "UNEXPECTED_SHAPE",
      "Console deployment cost consumer did not match the pinned actuator account"
    );
  }
  const leaseConsumer = requiredText(lease.id?.owner, "leases[0].id.owner");
  if (leaseConsumer !== consumer) {
    throw new AkashComputeError(
      "UNEXPECTED_SHAPE",
      "Console deployment and lease consumers disagree"
    );
  }
  const escrow = detail.escrow_account?.state;
  if (!escrow) {
    throw new AkashComputeError(
      "UNEXPECTED_SHAPE",
      "Console deployment cost response omitted escrow_account.state"
    );
  }
  const escrowConsumer = requiredText(
    escrow.owner,
    "escrow_account.state.owner"
  );
  if (escrowConsumer !== consumer) {
    throw new AkashComputeError(
      "UNEXPECTED_SHAPE",
      "Console deployment and escrow consumers disagree"
    );
  }
  const providerOpenedAtPosition = chainPosition(
    lease.created_at,
    "leases[0].created_at"
  );
  const providerClosedAtPosition = chainPosition(
    lease.closed_on,
    "leases[0].closed_on",
    true
  );
  const providerSettledAtPosition = chainPosition(
    escrow.settled_at,
    "escrow_account.state.settled_at",
    true
  );
  return {
    computeProvider: PROVIDER,
    resourceId,
    providerConsumerAccountId: consumer,
    providerSupplierAccountId: requiredText(
      lease.id?.provider,
      "leases[0].id.provider"
    ),
    rate: {
      amount: requiredNativeDecimal(
        lease.price?.amount,
        "leases[0].price.amount"
      ),
      denom: requiredDenom(lease.price?.denom, "leases[0].price.denom"),
      unit: "block",
    },
    ...(providerOpenedAtPosition ? { providerOpenedAtPosition } : {}),
    ...(providerClosedAtPosition ? { providerClosedAtPosition } : {}),
    escrow: {
      state: requiredText(escrow.state, "escrow_account.state.state"),
      ...(providerSettledAtPosition ? { providerSettledAtPosition } : {}),
      funds: nativeAmounts(escrow.funds, "escrow_account.state.funds", true),
      transferred: nativeAmounts(
        escrow.transferred,
        "escrow_account.state.transferred"
      ),
    },
    observedAt,
  };
}
