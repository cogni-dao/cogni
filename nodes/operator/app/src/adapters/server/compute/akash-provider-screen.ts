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
 *   - PIN_IS_A_PREFERENCE_NOT_A_GATE (story.5050): `allowedProviders` is an OPTIONAL PIN, not
 *     the authorization boundary. `undefined` AND the EMPTY set both mean "no pin — screen on
 *     policy alone"; ONLY a non-empty set narrows the pool. This deliberately INVERTS the
 *     original fail-closed reading, under which an empty list refused every bid. The reason
 *     is that a hand-maintained address enumeration is not a gate, it is a snapshot that
 *     rots: measured against the live registry on 2026-09-30, only 6 of the 11 pinned
 *     addresses could still win a bid at all — three declare `featEndpointCustomDomain=false`
 *     and two were offline — and the pin, not the Akash market, is what held one node to a
 *     single vendor across ten dry auctions. The boundary that matters is the conjunction of
 *     gates that each fire on their own merits: the on-chain `signedBy` audit anchor asserted
 *     in the SDL, the node catalog's fail-closed `requiredCountryCodes`, `passesQualityFilter`
 *     (which subsumes `isAudited`), the price-outlier exclusion, and the derived strike
 *     blacklist. Removing the pin removes NONE of those.
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
  /**
   * Whether the provider declares `featEndpointCustomDomain` — i.e. whether it will serve an
   * SDL `accept:` hostname at all. OPTIONAL on Akash, and three providers we have leased from
   * publish `false`.
   *
   * `undefined` means the registry read did not resolve, NOT "no": an unknown provider is
   * already refused by the quality filter, and treating absence as a refusal would turn one
   * failed marketplace read into a dry auction.
   */
  readonly supportsCustomDomain?: boolean | undefined;
}

/**
 * The country to screen a provider on.
 *
 * TWO FIELDS, ONE OF WHICH IS GUESSWORK. An Akash provider **declares** its location as a
 * signed on-chain attribute (`country`, `city`, `location-region`) — that is the operator's
 * own statement about where the datacenter is. Console *also* exposes `ipCountryCode`, which
 * is a **GeoIP lookup of the ingress address** and is a guess about a different thing.
 *
 * Prefer the declaration. The GeoIP field is wrong in the field and wrong in a way that is
 * invisible: `akash15pkdke…96hr` declares `country=NL, city=AMS,
 * datacenter=eu-west-ams-1, hosting-provider=Overclock`, and its ingress geolocates to
 * `GB / England / 51.5072,-0.1276` — central London, which is the default coordinate a
 * registrant gets when nothing better is known. Screened on GeoIP it is refused
 * `required_country` for a country it is not in; it was the only custom-domain-capable NL
 * provider on the network (story.5050).
 *
 * WHY NOT A CORRECTION TABLE: an override map keyed by owner address is a second
 * hand-maintained enumeration, and it rots the same way `AKASH_ALLOWED_PROVIDERS` has.
 * Reading the declared field fixes the whole class and auto-tracks every provider that
 * registers after today, with no human edit.
 *
 * NEITHER FIELD IS PROOF OF EGRESS. Both describe ingress/registration. Per
 * `REQUIRED_IS_A_POOL_NARROWER_NOT_A_PROOF` the only thing that establishes the identity a
 * workload presents to a third party is a probe from inside the lease.
 */
export function effectiveCountryCode(input: {
  /** The provider's own signed on-chain declaration. Preferred. */
  readonly declared?: string | null | undefined;
  /** GeoIP of the ingress address. Fallback only. */
  readonly geoIp?: string | null | undefined;
}): string | null {
  const norm = (v: string | null | undefined): string | null => {
    const t = v?.trim().toUpperCase();
    return t && /^[A-Z]{2}$/.test(t) ? t : null;
  };
  return norm(input.declared) ?? norm(input.geoIp);
}

/**
 * True when the two sources disagree, so the caller can log it. A disagreement is not an
 * error — it is the signal that a provider's GeoIP is stale, and it is the only way we would
 * ever notice the next one without re-running a manual audit.
 */
export function countrySourcesDisagree(input: {
  readonly declared?: string | null | undefined;
  readonly geoIp?: string | null | undefined;
}): boolean {
  const d = effectiveCountryCode({ declared: input.declared });
  const g = effectiveCountryCode({ declared: input.geoIp });
  return d !== null && g !== null && d !== g;
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
   * Whether THIS workload needs a provider that serves a custom hostname — true when any
   * global expose carries `hosts` (which `buildAkashSdl` renders as `accept:`). Every Cogni
   * node has a publicHost, so this is true in practice; it is a parameter rather than a
   * constant because a hostless internal workload must not be narrowed by a capability it
   * never uses.
   */
  readonly requiresCustomDomain: boolean;
  /**
   * OPTIONAL operator-owned provider PIN. `undefined` OR EMPTY = NO PIN: every bid is judged
   * on policy alone (audit anchor, required country, quality, price, strikes). A NON-EMPTY
   * set is a hard narrowing — only those addresses may be leased — so an operator can still
   * force a set for an incident, a migration, or an egress-coupled substrate.
   *
   * This is NOT a fail-closed gate. An empty value used to refuse every bid; it no longer
   * does (PIN_IS_A_PREFERENCE_NOT_A_GATE). Applied HERE rather than at the call site so an
   * empty survivor set can still name this filter as the cause instead of silently shrinking
   * the input.
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

/**
 * True when the provider passes the practitioner quality filter.
 *
 * A_BID_IS_NOT_A_POPULARITY_CONTEST (bug.5334). `activeLeases > 0` used to be required here as
 * "proof of registry egress". It is really a popularity proxy, and it is unsatisfiable for any
 * provider that does not already have a tenant — so it made a provider's FIRST lease with us
 * impossible to win. That cold-start trap, not the Akash market, is what blocked poly's gen-18:
 * `akash.rhite.co.uk` bid 9.14 on poly's own auction while reading
 * `isAudited=true, isValidVersion=true, isOnline=true, uptime7d=0.967,
 * featEndpointCustomDomain=true, leaseCount=0` — inside poly's permitted countries, capable of
 * serving its hostname, and refused by this one condition. Thirteen consecutive dry auctions
 * were attributed to jurisdiction and to the provider pool; this was in the conjunction the
 * whole time.
 *
 * What remains are signals that stand on their own merits and are not self-referential:
 * `isAudited` (on-chain attestation), `isValidVersion` (protocol compatibility — a genuinely
 * incompatible provider wins then fails), `isOnline`, and a 7-day uptime floor. Boot failures
 * are already answered by the derived strike blacklist, which is OUR OWN measured history
 * rather than someone else's tenancy count.
 */
export function passesQualityFilter(info: AkashProviderInfo): boolean {
  return (
    info.isAudited &&
    info.isValidVersion &&
    info.isOnline &&
    info.uptime7d > MIN_UPTIME_7D
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
  | "no_custom_domain"
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
    readonly requiresCustomDomain: boolean;
    readonly nowMs: number;
  }
): BidRejectionReason | undefined {
  if (ctx.excludedProviders.has(bid.provider)) return "already_tried";
  // PIN_IS_A_PREFERENCE_NOT_A_GATE: an EMPTY pin is NO pin, not "refuse everything". The
  // `.size > 0` is the whole inversion — read it as "only a pin an operator actually wrote
  // can narrow the pool"; a blanked overlay value now falls through to the policy gates
  // below instead of closing the auction.
  if (
    ctx.allowedProviders !== undefined &&
    ctx.allowedProviders.size > 0 &&
    !ctx.allowedProviders.has(bid.provider)
  ) {
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
  // DECLARED_INCAPACITY_IS_NOT_A_GAMBLE. `featEndpointCustomDomain` is OPTIONAL on Akash, and
  // a provider that publishes `false` will take the lease, start the pod, and never serve the
  // `accept:` hostname — so the workload 404s at its own public host, misses the boot SLO, and
  // `onGiveUp: Replace` spends a fresh lease to learn what the registry already said. Price is
  // the final rank tiebreak, so the cheapest bid wins; on poly's own order the cheapest bid in
  // its permitted set was a provider declaring `false` (story.5050, bug.5325). Refusing on the
  // declaration costs one skipped bid; not refusing costs up to three paid leases.
  //
  // Only a POSITIVE `false` refuses — see AkashProviderInfo.supportsCustomDomain on why
  // `undefined` must not.
  if (ctx.requiresCustomDomain && info?.supportsCustomDomain === false) {
    return "no_custom_domain";
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
    requiresCustomDomain,
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
      requiresCustomDomain,
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
