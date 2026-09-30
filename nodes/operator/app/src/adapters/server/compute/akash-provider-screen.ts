// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/compute/akash-provider-screen`
 * Purpose: Pure bid-screening + provider-blacklist logic for the Akash provider quality
 *   mandate (task.5051): quality-filter bids on Console provider data, exclude implausibly
 *   cheap outliers, derive blacklist state from outcome history, and rank the survivors.
 * Scope: Pure functions over already-fetched data. Does NOT call the Console API, read the
 *   DB, or know about dseqs/leases (adapter's job) — separated so every transition is unit
 *   testable without IO.
 * Invariants:
 *   - AUDITED_ONLY: with provider metadata available, a bid survives only if its provider is
 *     audited + valid-version + online + uptime7d > 0.95 + activeLeases > 0 (active leases =
 *     proof of registry egress; marketplace uptime measures the status port, not workload
 *     success — froggy-servers failed 3/3 leases at "100%" uptime).
 *   - FAIL_OPEN_ON_MISSING_METADATA: an empty provider map (Console read failed) skips the
 *     metadata filter — the SDL `signedBy` audit anchor remains the hard gate on-chain.
 *   - REQUIRED_FAILS_CLOSED: `requiredCountryCodes` is the one input that INVERTS the rule
 *     above. A PREFERENCE may fail open; a REQUIREMENT may not. When the set is non-empty, a
 *     bid survives only if its provider's country is KNOWN and in the set — unavailable
 *     metadata or an unknown country REFUSES the bid, because a requirement that cannot be
 *     evaluated is not satisfied (story.5050).
 *   - REQUIRED_IS_A_POOL_NARROWER_NOT_A_PROOF: the country compared is the provider's
 *     advertised/INGRESS identity, which is measurably not the EGRESS identity its workload
 *     presents to a third party — two providers in two advertised countries have shared one
 *     egress NAT. Only the workload's own outbound probe proves reachability.
 *   - EVERY_REJECTION_IS_COUNTED: screening returns per-reason counts alongside the survivors.
 *     Three independent filters can each empty the bid set, and an empty set previously
 *     surfaced as one static string after the full bid window (the `d69e5c29` class), so the
 *     caller must be able to say WHICH filter refused everything.
 *   - PRICE_IS_TIEBREAK_NEVER_CRITERION: cheapest WITHIN the screened set; bids ~2σ below
 *     the median price are excluded (absurd underbids are a negative signal, the classic
 *     underbidding-zombie tell).
 *   - BLACKLIST_IS_DERIVED: 24h TTL per SLO failure, permanent at 3 strikes — computed from
 *     append-only outcome history, cleared by deleting rows (never stored state).
 * Side-effects: none (pure)
 * Links: ./akash-compute.adapter (caller), ./provider-outcome-store (history source),
 *   knowledge hub `akash-provider-quality-mandate`, task.5051, task.5049 (DEV2 findings)
 * @internal
 */

/** Provider quality signals read from Console `GET /v1/providers` (only what we screen on). */
export interface AkashProviderInfo {
  /** Provider account address (akash1…). */
  readonly owner: string;
  readonly isAudited: boolean;
  readonly isOnline: boolean;
  readonly isValidVersion: boolean;
  /** 7-day uptime ratio in [0,1]. */
  readonly uptime7d: number;
  /** Count of currently active leases (proof of registry egress). */
  readonly activeLeases: number;
  /** ISO 3166-1 alpha-2 country code of the provider's ingress IP, when known. */
  readonly countryCode: string | null;
}

/**
 * Providers whose Console-advertised `ipCountryCode` is demonstrably WRONG, corrected to the
 * country their ingress address actually resolves to.
 *
 * WHY A MAP AND NOT A LOOKUP: the screener must stay a pure function over data we already
 * hold; resolving geo-IP at bid time would put a third-party network call inside a 90s
 * auction window and fail the whole placement when that service rate-limits. The registry is
 * the right source — it is just wrong for these entries, so we correct it at the seam with
 * the evidence recorded, rather than teaching every caller to distrust the field.
 *
 * REQUIRED_FAILS_CLOSED is unaffected: an override only ever replaces one concrete country
 * with another concrete country. It can never turn an unknown into a known, so a provider we
 * cannot place is still refused.
 *
 * Verified 2026-09-30 against ipinfo.io and ip-api.com, both agreeing:
 *
 * | provider | Console says | ingress resolves to | evidence |
 * | --- | --- | --- | --- |
 * | `akash15pkd…96hr` | GB | **NL** Amsterdam | `provider.h100.ams.val.akash.pub` → `24.144.74.0/24` (round-robins, e.g. `.158`/`.160`), AS394996, Amsterdam. That is the SAME /24 and ASN as `24.144.74.27`, already recorded in `infra/catalog/poly.yaml` as "Netherlands provider egress". The host name itself says `ams`. |
 * | `akash15tl6…mdhk` | US | **CA** Toronto | `provider.hurricane.akash.pub` → `184.105.162.170`, Toronto. 74 active leases. |
 *
 * Recorded for both even though only the first is presently allowlisted: the US→CA entry is
 * the one most likely to matter later, because Ontario is separately restricted by the very
 * kind of API that drives these placement requirements.
 */
export const PROVIDER_COUNTRY_OVERRIDES: ReadonlyMap<string, string> = new Map([
  ["akash15pkdkewzarpsx42t98vzf45h42hlq6ra8w96hr", "NL"],
  ["akash15tl6v6gd0nte0syyxnv57zmmspgju4c3xfmdhk", "CA"],
]);

/**
 * The country to screen a provider on: the corrected value when we have proven the registry
 * wrong, otherwise whatever the registry says.
 */
export function effectiveCountryCode(
  owner: string,
  advertised: string | null | undefined
): string | null {
  return (
    PROVIDER_COUNTRY_OVERRIDES.get(owner) ?? advertised?.toUpperCase() ?? null
  );
}

/** One provider's aggregated boot-outcome history (from compute_provider_outcomes). */
export interface ProviderOutcomeStats {
  readonly successes: number;
  readonly failures: number;
  /** Epoch ms of the most recent SLO failure, or null when the provider never failed. */
  readonly lastFailureAtMs: number | null;
}

/** The screenable projection of one open bid. */
export interface ScreenableBid {
  /** Provider account address (akash1…). */
  readonly provider: string;
  /** Bid price per block in chain micro-units (lower = cheaper). */
  readonly priceAmount: number;
}

export interface ScreenBidsInput {
  readonly bids: readonly ScreenableBid[];
  /** Provider metadata keyed by owner address; EMPTY map = metadata unavailable (fail open). */
  readonly providers: ReadonlyMap<string, AkashProviderInfo>;
  /** Outcome history keyed by owner address; missing entry = no history. */
  readonly outcomes: ReadonlyMap<string, ProviderOutcomeStats>;
  /** Allowlisted providers (substrate-egress coupled); strongest preference, never a filter. */
  readonly preferredProviders: readonly string[];
  /** Country codes considered co-located with the env substrate (latency preference). */
  readonly preferredCountryCodes: readonly string[];
  /**
   * Country codes the workload MUST be placed in (node-owned catalog requirement).
   * Empty = unconstrained. Non-empty = a hard filter, evaluated fail-closed per
   * REQUIRED_FAILS_CLOSED — NOT another entry in the preference ranking.
   */
  readonly requiredCountryCodes: readonly string[];
  /**
   * Providers the operator's fleet-wide boundary permits. `undefined` = no boundary
   * configured. Applied HERE rather than at the call site so an empty survivor set can name
   * this filter as the cause instead of silently shrinking the input.
   */
  readonly allowedProviders?: ReadonlySet<string> | undefined;
  /** Providers already tried (and failed) within the current provision attempt loop. */
  readonly excludedProviders: ReadonlySet<string>;
  readonly nowMs: number;
}

/** SLO-failure blacklist TTL: one recent failure sidelines a provider for 24h. */
export const BLACKLIST_TTL_MS = 24 * 60 * 60 * 1000;
/** Failures at which the blacklist becomes permanent (until history is manually cleared). */
export const BLACKLIST_PERMANENT_STRIKES = 3;
/** Minimum acceptable 7-day uptime ratio. */
export const MIN_UPTIME_7D = 0.95;
/** Bids more than this many standard deviations below the median price are excluded. */
const PRICE_OUTLIER_SIGMA = 2;

/**
 * Derived blacklist state: permanent at BLACKLIST_PERMANENT_STRIKES failures, else a
 * BLACKLIST_TTL_MS cooldown after the most recent failure.
 */
export function isProviderBlacklisted(
  stats: ProviderOutcomeStats | undefined,
  nowMs: number
): boolean {
  if (!stats) return false;
  if (stats.failures >= BLACKLIST_PERMANENT_STRIKES) return true;
  return (
    stats.lastFailureAtMs !== null &&
    nowMs - stats.lastFailureAtMs < BLACKLIST_TTL_MS
  );
}

/** True when the provider passes the practitioner quality filter (Console's own criteria). */
export function passesQualityFilter(info: AkashProviderInfo): boolean {
  return (
    info.isAudited &&
    info.isValidVersion &&
    info.isOnline &&
    info.uptime7d > MIN_UPTIME_7D &&
    info.activeLeases > 0
  );
}

/**
 * Providers whose bid price is implausibly cheap relative to the cohort (more than
 * PRICE_OUTLIER_SIGMA σ below the median). Needs ≥3 bids and price spread to fire.
 */
function priceOutlierProviders(
  bids: readonly ScreenableBid[]
): ReadonlySet<string> {
  if (bids.length < 3) return new Set();
  const prices = bids.map((b) => b.priceAmount).sort((a, b) => a - b);
  const mid = Math.floor(prices.length / 2);
  const median =
    prices.length % 2 === 0
      ? ((prices[mid - 1] ?? 0) + (prices[mid] ?? 0)) / 2
      : (prices[mid] ?? 0);
  const mean = prices.reduce((s, p) => s + p, 0) / prices.length;
  const sigma = Math.sqrt(
    prices.reduce((s, p) => s + (p - mean) ** 2, 0) / prices.length
  );
  if (sigma === 0) return new Set();
  const floor = median - PRICE_OUTLIER_SIGMA * sigma;
  return new Set(
    bids.filter((b) => b.priceAmount < floor).map((b) => b.provider)
  );
}

/** Why a bid did not survive screening. One counter per independent filter. */
export type BidRejectionReason =
  | "already_tried"
  | "not_allowlisted"
  | "required_country"
  | "blacklisted"
  | "quality"
  | "price_outlier";

/**
 * One bid's screening outcome, kept per-provider rather than aggregated.
 *
 * WHY THIS EXISTS: `rejections` counts are enough to name a cause but not enough to ACT on
 * one. `not_allowlisted=5` cannot distinguish "five providers we have never heard of bid"
 * from "the one provider we are waiting on bid and we refuse it ourselves" — and because
 * attribution is first-match-wins, a struck provider outside the country set is reported as
 * `required_country`, hiding its strikes entirely. Widening a gate on aggregate counts is
 * therefore a guess; eight consecutive poly auctions were re-rolled blind for exactly this
 * reason (story.5050). The roster makes an auction's outcome attributable to an ADDRESS.
 */
export interface BidVerdict {
  /** Provider account address (akash1…). */
  readonly provider: string;
  /** Bid price per block in chain micro-units. */
  readonly priceAmount: number;
  /** Provider's advertised ingress country, or null when metadata did not load. */
  readonly countryCode: string | null;
  /** The filter that refused this bid, or undefined when it survived screening. */
  readonly rejection?: BidRejectionReason | undefined;
}

export interface ScreenedBids {
  /** Survivors, best-first. */
  readonly ranked: readonly ScreenableBid[];
  /** Count of refused bids per reason. Zero-valued reasons are omitted. */
  readonly rejections: Readonly<Partial<Record<BidRejectionReason, number>>>;
  /** Every bid seen this round with its verdict, in arrival order. */
  readonly roster: readonly BidVerdict[];
}

/**
 * Decide one bid's fate. Order matters only for ATTRIBUTION — a bid refused by several
 * filters is counted against the first one, so the caller reads the most actionable cause
 * rather than an arbitrary one. Cheapest and most operator-actionable checks come first.
 */
function rejectionFor(
  bid: ScreenableBid,
  ctx: {
    readonly providers: ReadonlyMap<string, AkashProviderInfo>;
    readonly outcomes: ReadonlyMap<string, ProviderOutcomeStats>;
    readonly excludedProviders: ReadonlySet<string>;
    readonly allowedProviders: ReadonlySet<string> | undefined;
    readonly requiredCountries: ReadonlySet<string>;
    readonly nowMs: number;
  }
): BidRejectionReason | undefined {
  if (ctx.excludedProviders.has(bid.provider)) return "already_tried";
  if (ctx.allowedProviders && !ctx.allowedProviders.has(bid.provider)) {
    return "not_allowlisted";
  }
  const info = ctx.providers.get(bid.provider);
  // REQUIRED_FAILS_CLOSED. Unlike the preference path below, an unknown country or absent
  // metadata REFUSES rather than waves through: a requirement we cannot evaluate is not met.
  if (ctx.requiredCountries.size > 0) {
    const country = info?.countryCode?.toUpperCase();
    if (!country || !ctx.requiredCountries.has(country))
      return "required_country";
  }
  if (isProviderBlacklisted(ctx.outcomes.get(bid.provider), ctx.nowMs)) {
    return "blacklisted";
  }
  // FAIL_OPEN_ON_MISSING_METADATA: only screen on quality when the index actually loaded.
  if (ctx.providers.size > 0 && (!info || !passesQualityFilter(info))) {
    return "quality";
  }
  return undefined;
}

/**
 * Screen and rank open bids per the provider quality mandate. Returns surviving bids
 * best-first: allowlisted providers, then providers with proven own-history boot success,
 * then substrate-co-located providers (geography ≈ latency), price as the final tiebreak —
 * plus a per-reason count of everything refused, so an empty result can name its cause.
 */
export function screenBids(input: ScreenBidsInput): ScreenedBids {
  const {
    bids,
    providers,
    outcomes,
    preferredProviders,
    preferredCountryCodes,
    requiredCountryCodes,
    allowedProviders,
    excludedProviders,
    nowMs,
  } = input;

  const preferred = new Set(preferredProviders);
  const countries = new Set(preferredCountryCodes.map((c) => c.toUpperCase()));
  const requiredCountries = new Set(
    requiredCountryCodes.map((c) => c.toUpperCase())
  );

  const rejections: Partial<Record<BidRejectionReason, number>> = {};
  const count = (reason: BidRejectionReason): void => {
    rejections[reason] = (rejections[reason] ?? 0) + 1;
  };

  const eligible: ScreenableBid[] = [];
  const roster: BidVerdict[] = [];
  for (const bid of bids) {
    const reason = rejectionFor(bid, {
      providers,
      outcomes,
      excludedProviders,
      allowedProviders,
      requiredCountries,
      nowMs,
    });
    roster.push({
      provider: bid.provider,
      priceAmount: bid.priceAmount,
      countryCode: providers.get(bid.provider)?.countryCode ?? null,
      ...(reason ? { rejection: reason } : {}),
    });
    if (reason) count(reason);
    else eligible.push(bid);
  }

  // Priced relative to the ELIGIBLE cohort: an underbid is only a signal among peers that
  // could actually have won, so outlier detection must run after the hard filters.
  const outliers = priceOutlierProviders(eligible);
  const screened = eligible.filter((bid) => {
    if (!outliers.has(bid.provider)) return true;
    count("price_outlier");
    // The roster entry was written before outlier detection could run (it needs the
    // eligible cohort), so amend it rather than leaving a refused bid looking like a
    // survivor. Same first-match-wins attribution as every other reason.
    const at = roster.findIndex(
      (r) => r.provider === bid.provider && r.rejection === undefined
    );
    const entry = at === -1 ? undefined : roster[at];
    if (entry) {
      roster[at] = { ...entry, rejection: "price_outlier" };
    }
    return false;
  });

  const rank = (bid: ScreenableBid): readonly number[] => {
    const stats = outcomes.get(bid.provider);
    const info = providers.get(bid.provider);
    return [
      preferred.has(bid.provider) ? 0 : 1,
      stats && stats.successes > 0 ? 0 : 1,
      info?.countryCode && countries.has(info.countryCode.toUpperCase())
        ? 0
        : 1,
      bid.priceAmount,
    ];
  };

  const ranked = [...screened].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) {
      const d = (ra[i] ?? 0) - (rb[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  });

  return { ranked, rejections, roster };
}

/**
 * Render the per-bid roster for an error message, e.g.
 * `akash1hgu…4ezk PT 9.34 required_country, akash19tp…t48 CH 6.00 ok`.
 *
 * Addresses are elided in the middle: the first 9 and last 4 characters identify a provider
 * unambiguously against the allowlist while keeping a 7-bid roster inside one log line.
 */
export function formatBidRoster(roster: ScreenedBids["roster"]): string {
  if (roster.length === 0) return "none";
  return roster
    .map((r) => {
      const addr =
        r.provider.length > 17
          ? `${r.provider.slice(0, 9)}…${r.provider.slice(-4)}`
          : r.provider;
      const price = Number.isFinite(r.priceAmount)
        ? r.priceAmount.toFixed(2)
        : "n/a";
      return `${addr} ${r.countryCode ?? "??"} ${price} ${r.rejection ?? "ok"}`;
    })
    .join(", ");
}

/** Render rejection counts for an error message, e.g. `required_country=3, quality=1`. */
export function formatBidRejections(
  rejections: ScreenedBids["rejections"]
): string {
  const parts = Object.entries(rejections)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([reason, n]) => `${reason}=${n}`);
  return parts.length > 0 ? parts.join(", ") : "none";
}
