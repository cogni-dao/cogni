// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";
import {
  type AkashProviderInfo,
  BLACKLIST_TTL_MS,
  countrySourcesDisagree,
  effectiveCountryCode,
  formatBidRejections,
  formatBidRoster,
  isProviderBlacklisted,
  type ProviderOutcomeStats,
  passesQualityFilter,
  type ScreenableBid,
  type ScreenedBids,
  screenBids,
} from "./akash-provider-screen";

const NOW = 1_788_000_000_000;
const HOUR = 60 * 60 * 1000;

function info(
  owner: string,
  over: Partial<AkashProviderInfo> = {}
): AkashProviderInfo {
  return {
    owner,
    isAudited: true,
    isOnline: true,
    isValidVersion: true,
    uptime7d: 0.999,
    countryCode: "BE",
    ...over,
  };
}

describe("declared custom-domain capability", () => {
  /**
   * The exact near-miss from story.5050. On poly's own order the CHEAPEST bid inside its
   * permitted country set came from a provider publishing featEndpointCustomDomain=false
   * (CH, 6.00) while the capable one bid 7.00. Price is the final rank tiebreak, so without
   * this gate the incapable provider wins, takes a paid lease, serves nothing at the public
   * host, misses the boot SLO, and onGiveUp:Replace spends up to three leases to rediscover
   * what the registry already declared (bug.5325).
   */
  it("refuses a provider that declares it cannot serve a custom domain", () => {
    const providers = new Map([
      [
        "cheap-incapable",
        info("cheap-incapable", { supportsCustomDomain: false }),
      ],
      ["capable", info("capable", { supportsCustomDomain: true })],
    ]);
    const screened = screenFull(
      [bid("cheap-incapable", 6), bid("capable", 7)],
      {
        providers,
        requiresCustomDomain: true,
      }
    );
    expect(screened.ranked.map((b) => b.provider)).toEqual(["capable"]);
    expect(screened.rejections).toMatchObject({ no_custom_domain: 1 });
    expect(
      screened.roster.find((v) => v.provider === "cheap-incapable")?.rejection
    ).toBe("no_custom_domain");
  });

  /** A workload with no custom hostname must not be narrowed by a capability it never uses. */
  it("ignores the capability when the workload needs no custom domain", () => {
    const providers = new Map([
      ["incapable", info("incapable", { supportsCustomDomain: false })],
    ]);
    const screened = screenFull([bid("incapable", 6)], {
      providers,
      requiresCustomDomain: false,
    });
    expect(screened.ranked.map((b) => b.provider)).toEqual(["incapable"]);
  });

  /**
   * UNKNOWN_IS_NOT_NO. A failed /v1/providers read leaves the flag undefined; refusing on
   * absence would turn one bad marketplace call into NO_ELIGIBLE_BIDS across the fleet.
   */
  it("does not refuse when the provider never declared either way", () => {
    const providers = new Map([["silent", info("silent", {})]]);
    const screened = screenFull([bid("silent", 6)], {
      providers,
      requiresCustomDomain: true,
    });
    expect(screened.ranked.map((b) => b.provider)).toEqual(["silent"]);
    expect(screened.rejections.no_custom_domain).toBeUndefined();
  });
});

function bid(provider: string, priceAmount: number): ScreenableBid {
  return { provider, priceAmount };
}

function screenFull(
  bids: ScreenableBid[],
  over: Partial<Parameters<typeof screenBids>[0]> = {}
): ScreenedBids {
  return screenBids({
    bids,
    providers: new Map(),
    outcomes: new Map(),
    preferredProviders: [],
    requiresCustomDomain: false,
    preferredCountryCodes: [],
    requiredCountryCodes: [],
    excludedProviders: new Set(),
    nowMs: NOW,
    ...over,
  });
}

function screen(
  bids: ScreenableBid[],
  over: Partial<Parameters<typeof screenBids>[0]> = {}
): readonly ScreenableBid[] {
  return screenFull(bids, over).ranked;
}

describe("passesQualityFilter", () => {
  it("accepts an audited online valid-version provider with uptime and active leases", () => {
    expect(passesQualityFilter(info("akash1good"))).toBe(true);
  });

  it.each([
    ["unaudited", { isAudited: false }],
    ["offline", { isOnline: false }],
    ["invalid version", { isValidVersion: false }],
    ["uptime7d at threshold", { uptime7d: 0.95 }],
  ] as const)("rejects a provider that is %s", (_label, over) => {
    expect(passesQualityFilter(info("akash1bad", over))).toBe(false);
  });

  /**
   * A_BID_IS_NOT_A_POPULARITY_CONTEST (bug.5334). Zero current tenants must NOT refuse: the
   * old `activeLeases > 0` condition was unsatisfiable for any provider without an existing
   * tenant, so a provider's FIRST lease with us could never be won. That is what refused
   * `akash.rhite.co.uk` — audited, valid-version, online, uptime7d 0.967,
   * featEndpointCustomDomain=true, inside the node's permitted countries — after it had
   * already bid 9.14 on poly's own production auction (story.5050, gen-18).
   */
  it("accepts a healthy provider that has no tenants yet", () => {
    expect(passesQualityFilter(info("akash1newcomer"))).toBe(true);
  });
});

describe("isProviderBlacklisted", () => {
  const stats = (
    over: Partial<ProviderOutcomeStats>
  ): ProviderOutcomeStats => ({
    successes: 0,
    failures: 0,
    lastFailureAtMs: null,
    ...over,
  });

  it("no history → not blacklisted", () => {
    expect(isProviderBlacklisted(undefined, NOW)).toBe(false);
    expect(isProviderBlacklisted(stats({}), NOW)).toBe(false);
  });

  it("a failure within 24h → blacklisted (TTL)", () => {
    expect(
      isProviderBlacklisted(
        stats({ failures: 1, lastFailureAtMs: NOW - HOUR }),
        NOW
      )
    ).toBe(true);
  });

  it("a failure older than 24h → cooldown expired", () => {
    expect(
      isProviderBlacklisted(
        stats({ failures: 1, lastFailureAtMs: NOW - BLACKLIST_TTL_MS - 1 }),
        NOW
      )
    ).toBe(false);
  });

  it("3 strikes → permanent even when the last failure is old", () => {
    expect(
      isProviderBlacklisted(
        stats({ failures: 3, lastFailureAtMs: NOW - 30 * 24 * HOUR }),
        NOW
      )
    ).toBe(true);
  });
});

describe("screenBids quality filter", () => {
  it("drops providers failing the quality filter when metadata is available", () => {
    const providers = new Map([
      ["akash1good", info("akash1good")],
      ["akash1stale", info("akash1stale", { isValidVersion: false })],
      ["akash1down", info("akash1down", { isOnline: false })],
      // A provider with no tenants yet is NOT a quality failure — see
      // A_BID_IS_NOT_A_POPULARITY_CONTEST. It stays in the survivor set.
      ["akash1newcomer", info("akash1newcomer")],
    ]);
    const out = screen(
      [
        bid("akash1stale", 10),
        bid("akash1good", 500),
        bid("akash1down", 20),
        bid("akash1newcomer", 30),
      ],
      { providers }
    );
    expect(out.map((b) => b.provider)).toEqual([
      "akash1newcomer",
      "akash1good",
    ]);
  });

  it("drops providers unknown to the metadata index when metadata is available", () => {
    const providers = new Map([["akash1known", info("akash1known")]]);
    const out = screen([bid("akash1known", 500), bid("akash1ghost", 10)], {
      providers,
    });
    expect(out.map((b) => b.provider)).toEqual(["akash1known"]);
  });

  it("fails open (keeps all bidders) when provider metadata is unavailable", () => {
    const out = screen([bid("akash1a", 200), bid("akash1b", 100)]);
    expect(out.map((b) => b.provider)).toEqual(["akash1b", "akash1a"]);
  });
});

describe("screenBids blacklist + exclusions", () => {
  it("drops blacklisted providers", () => {
    const outcomes = new Map([
      [
        "akash1struck",
        { successes: 0, failures: 1, lastFailureAtMs: NOW - HOUR },
      ],
    ]);
    const out = screen([bid("akash1struck", 10), bid("akash1clean", 500)], {
      outcomes,
    });
    expect(out.map((b) => b.provider)).toEqual(["akash1clean"]);
  });

  it("drops providers already tried in this provision loop", () => {
    const out = screen([bid("akash1tried", 10), bid("akash1fresh", 500)], {
      excludedProviders: new Set(["akash1tried"]),
    });
    expect(out.map((b) => b.provider)).toEqual(["akash1fresh"]);
  });
});

describe("screenBids price-outlier exclusion", () => {
  it("drops a bid implausibly far below the median price", () => {
    const out = screen([
      bid("akash1a", 100),
      bid("akash1b", 100),
      bid("akash1c", 100),
      bid("akash1d", 100),
      bid("akash1zombie", 5),
    ]);
    expect(out.map((b) => b.provider)).not.toContain("akash1zombie");
    expect(out).toHaveLength(4);
  });

  it("keeps cheap-but-plausible bids (needs spread and cohort size to fire)", () => {
    expect(screen([bid("akash1a", 5), bid("akash1b", 100)])).toHaveLength(2);
    expect(
      screen([bid("akash1a", 100), bid("akash1b", 100), bid("akash1c", 100)])
    ).toHaveLength(3);
  });
});

describe("screenBids ranking", () => {
  it("prefers an allowlisted provider over a cheaper stranger", () => {
    const out = screen([bid("akash1zen", 900), bid("akash1cheap", 100)], {
      preferredProviders: ["akash1zen"],
    });
    expect(out[0]?.provider).toBe("akash1zen");
  });

  it("prefers a provider with proven boot history over a cheaper unknown", () => {
    const outcomes = new Map([
      ["akash1proven", { successes: 3, failures: 0, lastFailureAtMs: null }],
    ]);
    const out = screen([bid("akash1proven", 900), bid("akash1cheap", 100)], {
      outcomes,
    });
    expect(out[0]?.provider).toBe("akash1proven");
  });

  it("prefers a substrate-co-located provider over a cheaper distant one", () => {
    const providers = new Map([
      ["akash1near", info("akash1near", { countryCode: "LT" })],
      ["akash1far", info("akash1far", { countryCode: "US" })],
    ]);
    const out = screen([bid("akash1near", 900), bid("akash1far", 100)], {
      providers,
      preferredCountryCodes: ["LT", "DE"],
    });
    expect(out[0]?.provider).toBe("akash1near");
  });

  it("breaks ties on price within the same tier", () => {
    const out = screen([bid("akash1pricier", 500), bid("akash1cheaper", 100)]);
    expect(out.map((b) => b.provider)).toEqual([
      "akash1cheaper",
      "akash1pricier",
    ]);
  });

  it("allowlist outranks history, which outranks geography", () => {
    const providers = new Map([
      ["akash1pref", info("akash1pref", { countryCode: "US" })],
      ["akash1hist", info("akash1hist", { countryCode: "US" })],
      ["akash1near", info("akash1near", { countryCode: "LT" })],
    ]);
    const outcomes = new Map([
      ["akash1hist", { successes: 2, failures: 0, lastFailureAtMs: null }],
    ]);
    const out = screen(
      [bid("akash1near", 10), bid("akash1hist", 20), bid("akash1pref", 30)],
      {
        providers,
        outcomes,
        preferredProviders: ["akash1pref"],
        preferredCountryCodes: ["LT"],
      }
    );
    expect(out.map((b) => b.provider)).toEqual([
      "akash1pref",
      "akash1hist",
      "akash1near",
    ]);
  });
});

describe("screenBids provider pin (PIN_IS_A_PREFERENCE_NOT_A_GATE)", () => {
  // story.5050. The allowlist is retired as a GATE and kept only as a PIN. These pin the
  // INVERSION — an empty pin used to refuse every bid, which is how a blanked overlay value
  // (d69e5c29) closed auctions fleet-wide and how a rotting 11-address enumeration, 5 slots
  // of which had gone dead, became the real single-vendor constraint.
  it("an EMPTY pin is NO pin — every bid is still screened, none are refused for it", () => {
    const out = screenFull(
      [bid("akash1stranger", 100), bid("akash1other", 90)],
      {
        allowedProviders: new Set<string>(),
      }
    );
    expect(out.ranked.map((b) => b.provider)).toEqual([
      "akash1other",
      "akash1stranger",
    ]);
    expect(out.rejections).toEqual({});
  });

  it("an OMITTED pin is NO pin (unchanged)", () => {
    const out = screenFull([bid("akash1stranger", 100)]);
    expect(out.ranked.map((b) => b.provider)).toEqual(["akash1stranger"]);
    expect(out.rejections).toEqual({});
  });

  it("a NON-EMPTY pin still hard-narrows the pool", () => {
    const out = screenFull(
      [bid("akash1pinned", 900), bid("akash1stranger", 1)],
      {
        allowedProviders: new Set(["akash1pinned"]),
      }
    );
    expect(out.ranked.map((b) => b.provider)).toEqual(["akash1pinned"]);
    expect(out.rejections).toEqual({ not_allowlisted: 1 });
  });

  it("a NON-EMPTY pin that nobody matches still empties the set and names itself", () => {
    const out = screenFull([bid("akash1stranger", 100)], {
      allowedProviders: new Set(["akash1absent"]),
    });
    expect(out.ranked).toEqual([]);
    expect(out.rejections).toEqual({ not_allowlisted: 1 });
    expect(out.roster[0]).toMatchObject({ rejection: "not_allowlisted" });
  });

  it("removing the pin removes NO other gate — quality, country and strikes still refuse", () => {
    const out = screenFull(
      [bid("akash1pt", 100), bid("akash1weak", 100), bid("akash1struck", 100)],
      {
        allowedProviders: new Set<string>(),
        providers: new Map([
          ["akash1pt", info("akash1pt", { countryCode: "PT" })],
          [
            "akash1weak",
            info("akash1weak", { countryCode: "PT", isAudited: false }),
          ],
          ["akash1struck", info("akash1struck", { countryCode: "PT" })],
        ]),
        outcomes: new Map([
          [
            "akash1struck",
            { successes: 0, failures: 3, lastFailureAtMs: NOW - HOUR },
          ],
        ]),
        requiredCountryCodes: ["PT"],
      }
    );
    expect(out.ranked.map((b) => b.provider)).toEqual(["akash1pt"]);
    expect(out.rejections).toEqual({ blacklisted: 1, quality: 1 });
    expect(out.rejections.not_allowlisted).toBeUndefined();
  });

  it("an empty pin does not mask the node's fail-closed country requirement", () => {
    const out = screenFull([bid("akash1be", 100)], {
      allowedProviders: new Set<string>(),
      providers: new Map([
        ["akash1be", info("akash1be", { countryCode: "BE" })],
      ]),
      requiredCountryCodes: ["PT"],
    });
    expect(out.ranked).toEqual([]);
    expect(out.rejections).toEqual({ required_country: 1 });
  });
});

describe("screenBids required placement (REQUIRED_FAILS_CLOSED)", () => {
  const providers = new Map([
    ["akash1pt", info("akash1pt", { countryCode: "PT" })],
    ["akash1be", info("akash1be", { countryCode: "BE" })],
  ]);

  it("REFUSES a provider outside the required set even when it is cheaper and preferred", () => {
    const out = screen([bid("akash1be", 10), bid("akash1pt", 900)], {
      providers,
      requiredCountryCodes: ["PT"],
      preferredProviders: ["akash1be"],
    });
    expect(out.map((b) => b.provider)).toEqual(["akash1pt"]);
  });

  /**
   * The whole point of the cell. `preferredCountryCodes` only reorders, so a hostile
   * jurisdiction still WINS when it is cheaper — which is how poly's production workload sat
   * in a Polymarket-restricted country while placement policy looked satisfied (bug.5270).
   */
  it("filters where the latency preference merely ranks", () => {
    const preferenceOnly = screen([bid("akash1be", 10), bid("akash1pt", 900)], {
      providers,
      preferredCountryCodes: ["PT"],
    });
    expect(preferenceOnly.map((b) => b.provider)).toContain("akash1be");

    const required = screen([bid("akash1be", 10), bid("akash1pt", 900)], {
      providers,
      requiredCountryCodes: ["PT"],
    });
    expect(required.map((b) => b.provider)).not.toContain("akash1be");
  });

  /**
   * REQUIRED_FAILS_CLOSED. The preference path deliberately fails OPEN when the Console
   * provider index is unavailable; a requirement must not, or an unreadable marketplace
   * silently places a geo-constrained node anywhere.
   */
  it("refuses every bid when provider metadata is unavailable", () => {
    const out = screenFull([bid("akash1pt", 100), bid("akash1be", 100)], {
      providers: new Map(),
      requiredCountryCodes: ["PT"],
    });
    expect(out.ranked).toEqual([]);
    expect(out.rejections.required_country).toBe(2);
  });

  it("refuses a provider whose country is simply unknown", () => {
    const out = screenFull([bid("akash1mystery", 100)], {
      providers: new Map([
        ["akash1mystery", info("akash1mystery", { countryCode: null })],
      ]),
      requiredCountryCodes: ["PT"],
    });
    expect(out.ranked).toEqual([]);
    expect(out.rejections.required_country).toBe(1);
  });

  it("is inert when no requirement is declared, preserving today's behaviour", () => {
    const out = screen([bid("akash1be", 10), bid("akash1pt", 900)], {
      providers,
      requiredCountryCodes: [],
    });
    expect(out).toHaveLength(2);
  });

  it("compares case-insensitively so a lowercase cell cannot silently refuse everything", () => {
    const out = screen([bid("akash1pt", 100)], {
      providers: new Map([
        ["akash1pt", info("akash1pt", { countryCode: "pt" })],
      ]),
      requiredCountryCodes: ["Pt"],
    });
    expect(out.map((b) => b.provider)).toEqual(["akash1pt"]);
  });
});

describe("screenBids rejection accounting (EVERY_REJECTION_IS_COUNTED)", () => {
  /**
   * Three independent filters can each empty the bid set and the caller previously got one
   * static sentence after the whole bid window. An operator must be able to read WHICH filter
   * refused everything — the `d69e5c29` blanked-allowlist incident was invisible for exactly
   * this reason.
   */
  it("attributes the fleet allowlist separately from the node's country requirement", () => {
    const out = screenFull([bid("akash1pt", 100), bid("akash1be", 100)], {
      providers: new Map([
        ["akash1pt", info("akash1pt", { countryCode: "PT" })],
        ["akash1be", info("akash1be", { countryCode: "BE" })],
      ]),
      allowedProviders: new Set(["akash1be"]),
      requiredCountryCodes: ["PT"],
    });
    expect(out.ranked).toEqual([]);
    expect(out.rejections).toEqual({
      not_allowlisted: 1,
      required_country: 1,
    });
  });

  it("counts an excluded provider as already_tried, not as a quality failure", () => {
    const out = screenFull([bid("akash1tried", 100)], {
      excludedProviders: new Set(["akash1tried"]),
    });
    expect(out.rejections).toEqual({ already_tried: 1 });
  });

  it("counts blacklist and quality refusals under their own reasons", () => {
    const out = screenFull([bid("akash1struck", 100), bid("akash1weak", 100)], {
      providers: new Map([
        ["akash1struck", info("akash1struck")],
        ["akash1weak", info("akash1weak", { isAudited: false })],
      ]),
      outcomes: new Map([
        [
          "akash1struck",
          { successes: 0, failures: 1, lastFailureAtMs: NOW - HOUR },
        ],
      ]),
    });
    expect(out.rejections).toEqual({ blacklisted: 1, quality: 1 });
  });

  it("reports nothing refused when every bid survives", () => {
    const out = screenFull([bid("akash1a", 100), bid("akash1b", 100)]);
    expect(out.rejections).toEqual({});
    expect(formatBidRejections(out.rejections)).toBe("none");
  });

  it("formats counts for an error message", () => {
    expect(formatBidRejections({ required_country: 3, quality: 1 })).toBe(
      "required_country=3, quality=1"
    );
  });
});

describe("bid roster", () => {
  // story.5050: eight poly auctions were re-rolled on aggregate counts alone. These pin the
  // property that made that possible — a refused bid must stay attributable to an ADDRESS.
  it("records every bid seen, survivors and refusals alike", () => {
    const { roster } = screenFull([bid("akash-a", 5), bid("akash-b", 9)], {
      allowedProviders: new Set(["akash-a"]),
    });
    expect(roster).toHaveLength(2);
    expect(roster[0]).toMatchObject({ provider: "akash-a", priceAmount: 5 });
    expect(roster[0]?.rejection).toBeUndefined();
    expect(roster[1]).toMatchObject({
      provider: "akash-b",
      rejection: "not_allowlisted",
    });
  });

  it("carries the country that the aggregate count cannot express", () => {
    const { roster } = screenFull([bid("akash-a", 5)], {
      providers: new Map([["akash-a", info("akash-a", { countryCode: "PT" })]]),
      requiredCountryCodes: ["BG"],
    });
    expect(roster[0]).toMatchObject({
      countryCode: "PT",
      rejection: "required_country",
    });
  });

  it("reports an unknown country as null rather than guessing", () => {
    const { roster } = screenFull([bid("akash-a", 5)]);
    expect(roster[0]?.countryCode).toBeNull();
  });

  it("amends the entry of a bid refused as a price outlier after the fact", () => {
    // Outlier detection runs on the eligible cohort, so it cannot be decided in the
    // first pass; a refused outlier must not be left looking like a survivor.
    const { roster, rejections } = screenFull([
      bid("akash-a", 1),
      bid("akash-b", 100),
      bid("akash-c", 101),
      bid("akash-d", 102),
    ]);
    expect(rejections.price_outlier).toBe(1);
    const outlier = roster.find((r) => r.provider === "akash-a");
    expect(outlier?.rejection).toBe("price_outlier");
    expect(
      roster.filter((r) => r.rejection === undefined).map((r) => r.provider)
    ).toEqual(["akash-b", "akash-c", "akash-d"]);
  });

  it("renders an actionable line, eliding the middle of each address", () => {
    const line = formatBidRoster([
      {
        provider: "akash1hgulk6aekakqzc0v6wukrd3dy9n90f5gkl4ezk",
        priceAmount: 9.34,
        countryCode: "PT",
        rejection: "required_country",
      },
      { provider: "akash1short", priceAmount: 6, countryCode: null },
    ]);
    expect(line).toBe(
      "akash1hgu…4ezk PT 9.34 required_country, akash1short ?? 6.00 ok"
    );
  });

  it("renders an empty roster as none", () => {
    expect(formatBidRoster([])).toBe("none");
  });
});

describe("provider country resolution", () => {
  // story.5050: akash15pkdke… DECLARES country=NL, city=AMS, datacenter=eu-west-ams-1 on
  // chain, while its ingress GeoIPs to GB/London (51.5072,-0.1276 — a registrant default).
  // Screening on GeoIP refused the only custom-domain-capable NL provider on the network.
  it("prefers the provider's own declaration over GeoIP", () => {
    expect(effectiveCountryCode({ declared: "NL", geoIp: "GB" })).toBe("NL");
  });

  it("falls back to GeoIP when nothing is declared", () => {
    expect(effectiveCountryCode({ declared: null, geoIp: "pt" })).toBe("PT");
    expect(effectiveCountryCode({ geoIp: "PT" })).toBe("PT");
  });

  it("keeps unknown unknown — resolution never invents a country", () => {
    // REQUIRED_FAILS_CLOSED depends on this: null must stay null so the bid is refused.
    expect(effectiveCountryCode({ declared: null, geoIp: null })).toBeNull();
    expect(effectiveCountryCode({})).toBeNull();
  });

  it("rejects malformed values from EITHER source rather than trusting them", () => {
    // A provider can declare anything; a free-text region must not become a country code.
    expect(effectiveCountryCode({ declared: "eu-west", geoIp: "NL" })).toBe(
      "NL"
    );
    expect(
      effectiveCountryCode({ declared: "Netherlands", geoIp: "" })
    ).toBeNull();
  });

  it("flags a disagreement so a stale GeoIP is visible without a manual audit", () => {
    expect(countrySourcesDisagree({ declared: "NL", geoIp: "GB" })).toBe(true);
    expect(countrySourcesDisagree({ declared: "NL", geoIp: "NL" })).toBe(false);
  });

  it("does not flag when only one source is usable", () => {
    expect(countrySourcesDisagree({ declared: "NL", geoIp: null })).toBe(false);
    expect(countrySourcesDisagree({ declared: "eu-west", geoIp: "GB" })).toBe(
      false
    );
  });

  it("admits the provider once its declared country is permitted", () => {
    const { ranked } = screenFull([bid("akash15pkd", 5)], {
      providers: new Map([
        ["akash15pkd", info("akash15pkd", { countryCode: "NL" })],
      ]),
      requiredCountryCodes: ["BG", "FI", "NL", "PT", "RO"],
    });
    expect(ranked.map((b) => b.provider)).toEqual(["akash15pkd"]);
  });
});
