// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `operator-finance.test`
 * Purpose: Prove per-day conversion of on-chain lease prices, one row per node, Cherry credit mapping, and the reader composition.
 * Scope: Pure projection and injected compute port fakes; no network or DB.
 * Invariants: No FX between currencies, no fabricated runway, provider errors never leak.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/task.5347
 * @internal
 */
import { drizzle as drizzleProxy } from "drizzle-orm/pg-proxy";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AKASH_PRODUCTION_OWNER,
  akashCreditReader,
  readAkashBlocksPerDay,
  sumUact,
} from "@/adapters/server/finance/akash-credit.reader";
import { cherryFinanceReader } from "@/adapters/server/finance/cherry-finance.reader";
import {
  CREDITED_STATUS,
  creditedPurchasesQuery,
} from "@/adapters/server/finance/credit-purchase-income.query";
import {
  domainExpiryReader,
  expiryDays,
} from "@/adapters/server/finance/domain-expiry.reader";
import {
  grafanaOverageReader,
  overagePerDay,
} from "@/adapters/server/finance/grafana-overage.reader";
import {
  AKASH_RATE_SOURCE,
  akashHostingReaders,
  akashHostingRow,
  akashUsdPerDay,
  collapseAkash,
  readAkashReports,
} from "@/adapters/server/finance/operator-finance.adapter";

import { uniqueWalletBindings } from "@/bootstrap/capabilities/finance-wallets";

const runtime = vi.hoisted(() => ({
  dao: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as string | undefined,
  account: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
  env: { EVM_RPC_URL: "https://rpc.example" } as Record<
    string,
    string | undefined
  >,
  balances: vi.fn(async () => [] as unknown[]),
  report: vi.fn(async () => [] as unknown[]),
  purchases: { totalUsdCents: 0, count: 0 },
  serviceDb: {} as unknown,
}));
runtime.serviceDb = {
  select: () => ({
    from: () => ({
      innerJoin: () => ({ where: async () => [runtime.purchases] }),
    }),
  }),
};
vi.mock("@/adapters/server/db/drizzle.service-client", () => ({
  getServiceDb: () => runtime.serviceDb,
}));
vi.mock("@/adapters/server", async () => ({
  ...(await import("@/adapters/server/finance/operator-finance.adapter")),
  ...(await import("@/adapters/server/finance/credit-purchase-income.query")),
  ...(await import("@/adapters/server/finance/akash-credit.reader")),
  ...(await import("@/adapters/server/finance/cherry-finance.reader")),
  ...(await import("@/adapters/server/finance/grafana-overage.reader")),
  ...(await import("@/adapters/server/finance/domain-expiry.reader")),
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    akashSpendReader: { reportByNode: runtime.report },
    computeCapability: { balances: runtime.balances },
  }),
}));
vi.mock("@/shared/env", () => ({ serverEnv: () => runtime.env }));
vi.mock("@/shared/config", () => ({
  getDaoTreasuryAddress: () => runtime.dao,
  getOperatorWalletConfig: () => ({ address: runtime.account }),
  getStewardWalletConfig: () => ({ address: runtime.account }),
}));

import { type MoneyPlaneRow, takeSnapshot } from "@cogni/money-plane";
import { createFinanceReaders } from "@/bootstrap/capabilities/finance";

afterEach(() => {
  vi.unstubAllGlobals();
  runtime.dao = runtime.account;
  runtime.env = { EVM_RPC_URL: "https://rpc.example" };
  vi.clearAllMocks();
});
const at = "2026-10-25T00:00:00.000Z";
const node = (
  nodeId: string,
  activeRates: { amount: string; denom: string; unit: string }[],
  transferred: { amount: string; denom: string }[] = []
) => ({
  nodeId,
  allocatedIntervals: 0,
  activeIntervals: activeRates.length,
  closedIntervals: 0,
  activeRates,
  transferred,
});

describe("operator finance evidence", () => {
  it("converts an on-chain uact price per block to USD per day with 5.884 s/block", () => {
    expect(
      akashUsdPerDay({ amount: "2", denom: "uact", unit: "block" })
    ).toBeCloseTo((2 * (86_400 / 5.884)) / 1e6, 9);
    expect(akashUsdPerDay({ amount: "3", denom: "uact", unit: "day" })).toBe(
      3e-6
    );
    expect(
      akashUsdPerDay({ amount: "304", denom: "uact", unit: "month" })
    ).toBeCloseTo(1e-5, 12);
    expect(akashUsdPerDay({ amount: "2", denom: "uakt", unit: "block" })).toBe(
      null
    );
    expect(akashUsdPerDay({ amount: "2", denom: "uact", unit: "hour" })).toBe(
      null
    );
    expect(
      akashUsdPerDay({ amount: "nope", denom: "uact", unit: "block" })
    ).toBe(null);
  });
  it("projects one row per node with the exact native rate, transfers and attribution", () => {
    const row = akashHostingRow(
      node(
        "poly",
        [{ amount: "106.93", denom: "uact", unit: "block" }],
        [
          { amount: "4210000", denom: "uact" },
          { amount: "11", denom: "uakt" },
        ]
      ),
      at
    );
    expect(row).toMatchObject({
      plane: "akash:poly",
      label: "Akash · poly",
      kind: "usage",
      balance: null,
      currency: "USD",
      runwayDays: null,
      grade: "INFO",
      source: AKASH_RATE_SOURCE,
      sourceObservedAt: null,
      payer: "Operator",
      beneficiary: "poly",
      coverage: "operator-covered",
      nativeRate: { amount: "106.93", currency: "uact", per: "block" },
      cumulativeVendorTransfer: { amount: "4210000", currency: "uact" },
    });
    expect(row.burnPerDay).toBeCloseTo(1.57, 2);
  });
  it("sums several priced leases on one node and marks unpriced or lease-less nodes unknown", () => {
    const two = akashHostingRow(
      node("red", [
        { amount: "1", denom: "uact", unit: "day" },
        { amount: "2", denom: "uact", unit: "day" },
        { amount: "9", denom: "uakt", unit: "block" },
      ]),
      at
    );
    expect(two.burnPerDay).toBeCloseTo(3e-6, 12);
    expect(two.nativeRate).toBeUndefined();
    expect(two.detail).toBe("2 active leases");
    expect(
      akashHostingRow(
        node("blue", [{ amount: "9", denom: "uakt", unit: "block" }]),
        at
      )
    ).toMatchObject({
      grade: "UNKNOWN",
      reasonCode: "unreadable",
      burnPerDay: null,
      beneficiary: "blue",
    });
    expect(akashHostingRow(node("idle", []), at)).toMatchObject({
      grade: "UNKNOWN",
      reasonCode: "no_leases",
      burnPerDay: null,
    });
  });
  it("treats an unreadable or empty cost ledger as one unknown fleet row without leaking errors", async () => {
    const failed = await readAkashReports(async () => {
      throw new Error("sensitive-token-value");
    });
    expect(failed).toBeNull();
    for (const [reports, reasonCode] of [
      [null, "unreadable"],
      [[], "no_leases"],
    ] as const) {
      const readers = akashHostingReaders(reports, at);
      expect(readers).toHaveLength(1);
      const row = await readers[0]?.read(new AbortController().signal);
      expect(row).toMatchObject({
        plane: "akash:fleet",
        label: "Akash hosting",
        grade: "UNKNOWN",
        reasonCode,
        burnPerDay: null,
      });
      expect(JSON.stringify(row)).not.toContain("sensitive-token-value");
    }
  });
  it("keeps INFO on a cost line with a measured burn and no balance (package floor, v6)", async () => {
    const readers = akashHostingReaders(
      [node("poly", [{ amount: "2", denom: "uact", unit: "block" }])],
      at
    );
    const snapshot = await takeSnapshot(readers, { timeoutMs: 500 });
    expect(snapshot.rows[0]).toMatchObject({ grade: "INFO", runwayDays: null });
  });
  it("collapses hosting rows into children of the one Akash row and fills burn from the ledger when the chain is unread", () => {
    const parent: MoneyPlaneRow = {
      plane: "akash:credit",
      label: "Akash",
      kind: "prepaid",
      balance: 7.89,
      currency: "USD",
      burnPerDay: 3.13,
      runwayDays: 2.52,
      grade: "RED",
      observedAt: at,
      sourceObservedAt: at,
      freshness: "current",
    };
    const poly = akashHostingRow(
      node("poly", [{ amount: "1", denom: "uact", unit: "day" }]),
      at
    );
    const red = akashHostingRow(
      node("red", [{ amount: "2", denom: "uact", unit: "day" }]),
      at
    );
    const other: MoneyPlaneRow = {
      ...parent,
      plane: "cherry:team",
      label: "Cherry credit",
    };
    const rows = collapseAkash([other, parent, poly, red]);
    expect(rows.map((r) => r.plane)).toEqual(["cherry:team", "akash:credit"]);
    expect(rows[1]?.children?.map((c) => c.plane)).toEqual([
      "akash:poly",
      "akash:red",
    ]);
    expect(rows[1]?.burnPerDay).toBe(3.13);
    const unread = collapseAkash([
      {
        ...parent,
        balance: null,
        burnPerDay: null,
        runwayDays: null,
        grade: "UNKNOWN",
        reasonCode: "unreadable",
      },
      poly,
      red,
    ]);
    expect(unread[0]?.burnPerDay).toBeCloseTo(3e-6, 12);
    expect(unread[0]?.children).toHaveLength(2);
    const noParent = collapseAkash([poly]);
    expect(noParent[0]).toMatchObject({
      plane: "akash:credit",
      label: "Akash",
      grade: "UNKNOWN",
      rail: { kind: "card-manual", status: "planned", guide: "Console" },
    });
    expect(noParent[0]?.children?.[0]?.plane).toBe("akash:poly");
    expect(collapseAkash([other])).toEqual([other]);
  });
  it("builds the credited-time income query on the payment_attempts status index with a CREDITED-event join and SQL aggregate", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const db = drizzleProxy(async (sqlText, params) => {
      calls.push({ sql: sqlText, params });
      return { rows: [["4500", "3"]] };
    });
    const since = new Date("2026-09-26T00:00:00.000Z");
    const totals = await creditedPurchasesQuery(db as never)(
      since,
      new AbortController().signal
    );
    expect(totals).toEqual({ totalUsdCents: 4500, count: 3 });
    expect(CREDITED_STATUS).toBe("CREDITED");
    const q = calls[0]?.sql.replace(/\s+/g, " ") ?? "";
    expect(q).toMatch(/from "payment_attempts"/);
    expect(q).toMatch(
      /inner join "payment_events" on \("payment_events"\."attempt_id" = "payment_attempts"\."id" and "payment_events"\."to_status" = \$\d\)/
    );
    expect(q).toMatch(/"payment_attempts"\."status" = \$\d/);
    expect(q).toMatch(/"payment_events"\."created_at" >= \$\d/);
    expect(q).not.toMatch(/"payment_attempts"\."created_at"/);
    expect(q).toMatch(
      /coalesce\(sum\("payment_attempts"\."amount_usd_cents"\), 0\)/
    );
    expect(q).toMatch(/count\(\*\)/);
    expect(calls[0]?.params.filter((p) => p === "CREDITED")).toHaveLength(2);
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      creditedPurchasesQuery(db as never)(since, aborted.signal)
    ).rejects.toThrow("income query aborted");
    expect(calls).toHaveLength(1);
  });
  it("ports akashPlane: grant credit + escrow, lease burn at the chain cadence, thinnest escrow, graded runway", async () => {
    const signal = new AbortController().signal;
    const urls: string[] = [];
    const fetch = async (url: string) => {
      urls.push(url);
      const body = url.includes("/authz/")
        ? {
            grants: [
              {
                authorization: {
                  "@type": "/cosmos.bank.v1beta1.SendAuthorization",
                },
              },
              {
                granter: "akash1console",
                authorization: {
                  "@type": "/akash.deployment.v1beta3.DepositAuthorization",
                  spend_limits: [
                    { denom: "uact", amount: "5790000" },
                    { denom: "uakt", amount: "0" },
                  ],
                },
              },
            ],
          }
        : url.includes("/deployments/")
          ? {
              deployments: [
                {
                  deployment: { id: { dseq: "1" } },
                  escrow_account: {
                    state: { funds: [{ denom: "uact", amount: "1500000" }] },
                  },
                },
                {
                  deployment: { id: { dseq: "2" } },
                  escrow_account: {
                    state: { funds: [{ denom: "uact", amount: "600000" }] },
                  },
                },
                { deployment: { id: { dseq: "3" } }, escrow_account: null },
              ],
            }
          : {
              leases: [
                {
                  lease: {
                    id: { dseq: "1" },
                    price: { denom: "uact", amount: "100" },
                  },
                },
                {
                  lease: {
                    id: { dseq: "2" },
                    price: { denom: "uact", amount: "113.15" },
                  },
                },
              ],
            };
      return { ok: true, status: 200, json: async () => body };
    };
    const bpd = 14_683;
    const row = await akashCreditReader({
      owner: AKASH_PRODUCTION_OWNER,
      fetch,
      blocksPerDay: bpd,
    }).read(signal);
    const q = `filters.owner=${AKASH_PRODUCTION_OWNER}&filters.state=active&pagination.limit=500`;
    expect(urls).toEqual([
      `https://api.akashnet.net/cosmos/authz/v1beta1/grants/grantee/${AKASH_PRODUCTION_OWNER}`,
      `https://api.akashnet.net/akash/deployment/v1beta4/deployments/list?${q}`,
      `https://api.akashnet.net/akash/market/v1beta5/leases/list?${q}`,
    ]);
    const burn = (213.15 * bpd) / 1e6;
    expect(row).toMatchObject({
      plane: "akash:credit",
      label: "Akash",
      kind: "prepaid",
      currency: "USD",
      grade: "RED",
      payer: "Operator",
      rail: { kind: "card-manual", status: "planned", guide: "Console" },
      nativeRate: { amount: "213.15", currency: "uact", per: "block" },
      parts: [
        { label: "Console credit", amount: "5790000", currency: "uact" },
        { label: "Escrow", amount: "2100000", currency: "uact" },
      ],
    });
    expect(row.balance).toBeCloseTo(7.89, 9);
    expect(row.burnPerDay).toBeCloseTo(burn, 9);
    expect(row.runwayDays).toBeCloseTo(7.89 / burn, 9);
    expect(row.source).toBe(
      "Akash chain · Console grant + escrow · 2 leases at 14,683 blocks/day (measured)"
    );
    const pooled = (7.89 / burn).toFixed(1);
    const thinnest = (600000 / (113.15 * bpd)).toFixed(1);
    expect(row.detail).toBe(
      `Pooled ${pooled}d · Thinnest ${thinnest}d (dseq 2)`
    );
    const fallback = await akashCreditReader({
      owner: "x",
      fetch,
      blocksPerDay: null,
    }).read(signal);
    expect(fallback.source).toContain("5.884 s/block fallback");
    expect(fallback.burnPerDay).toBeCloseTo(
      (213.15 * (86_400 / 5.884)) / 1e6,
      9
    );
  });
  it("grades the thinnest deployment when Console credit is zero: $1 escrow at $1/day is RED 1d, not pooled GREEN", async () => {
    const signal = new AbortController().signal;
    const bpd = 1e6; // 1 uact/block ⇒ 1 USD/day, so prices read as $/day
    const fetch = async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.includes("/authz/")
          ? {
              grants: [
                {
                  authorization: {
                    "@type": "/akash.deployment.v1beta3.DepositAuthorization",
                    spend_limits: [{ denom: "uact", amount: "0" }],
                  },
                },
              ],
            }
          : url.includes("/deployments/")
            ? {
                deployments: [
                  {
                    deployment: { id: { dseq: "A" } },
                    escrow_account: {
                      state: { funds: [{ denom: "uact", amount: "1000000" }] },
                    },
                  },
                  {
                    deployment: { id: { dseq: "B" } },
                    escrow_account: {
                      state: { funds: [{ denom: "uact", amount: "99000000" }] },
                    },
                  },
                ],
              }
            : {
                leases: [
                  {
                    lease: {
                      id: { dseq: "A" },
                      price: { denom: "uact", amount: "1" },
                    },
                  },
                  {
                    lease: {
                      id: { dseq: "B" },
                      price: { denom: "uact", amount: "1" },
                    },
                  },
                ],
              },
    });
    const row = await akashCreditReader({
      owner: "x",
      fetch,
      blocksPerDay: bpd,
    }).read(signal);
    expect(row.balance).toBeCloseTo(100, 9);
    expect(row.burnPerDay).toBeCloseTo(2, 9);
    expect(row.runwayDays).toBeCloseTo(1, 9);
    expect(row.grade).toBe("RED");
    expect(row.detail).toBe("Pooled 50.0d · Thinnest 1.0d (dseq A)");
  });
  it("sums several leases on one deployment and lets shared Console credit grade on the pooled figure", async () => {
    const signal = new AbortController().signal;
    const bpd = 1e6;
    const make = (credit: string) => async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.includes("/authz/")
          ? {
              grants: [
                {
                  authorization: {
                    "@type": "/akash.deployment.v1beta3.DepositAuthorization",
                    spend_limits: [{ denom: "uact", amount: credit }],
                  },
                },
              ],
            }
          : url.includes("/deployments/")
            ? {
                deployments: [
                  {
                    deployment: { id: { dseq: "A" } },
                    escrow_account: {
                      state: { funds: [{ denom: "uact", amount: "4000000" }] },
                    },
                  },
                ],
              }
            : {
                leases: [
                  {
                    lease: {
                      id: { dseq: "A" },
                      price: { denom: "uact", amount: "1" },
                    },
                  },
                  {
                    lease: {
                      id: { dseq: "A" },
                      price: { denom: "uact", amount: "3" },
                    },
                  },
                ],
              },
    });
    const zero = await akashCreditReader({
      owner: "x",
      fetch: make("0"),
      blocksPerDay: bpd,
    }).read(signal);
    expect(zero.burnPerDay).toBeCloseTo(4, 9);
    expect(zero.runwayDays).toBeCloseTo(1, 9);
    expect(zero.detail).toBe("Pooled 1.0d · Thinnest 1.0d (dseq A)");
    const funded = await akashCreditReader({
      owner: "x",
      fetch: make("96000000"),
      blocksPerDay: bpd,
    }).read(signal);
    expect(funded.balance).toBeCloseTo(100, 9);
    expect(funded.runwayDays).toBeCloseTo(25, 9);
    expect(funded.grade).toBe("GREEN");
    expect(funded.detail).toBe("Pooled 25.0d · Thinnest 1.0d (dseq A)");
  });
  it("never turns a missing or malformed bill into zero spending", async () => {
    const signal = new AbortController().signal;
    const grant = {
      grants: [
        {
          authorization: {
            "@type": "/akash.deployment.v1beta3.DepositAuthorization",
            spend_limits: [{ denom: "uact", amount: "5000000" }],
          },
        },
      ],
    };
    const deployments = {
      deployments: [
        {
          deployment: { id: { dseq: "A" } },
          escrow_account: {
            state: { funds: [{ denom: "uact", amount: "2000000" }] },
          },
        },
      ],
    };
    const withLeases = (leases: unknown) => async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.includes("/authz/")
          ? grant
          : url.includes("/deployments/")
            ? deployments
            : leases,
    });
    const cases: [unknown, string][] = [
      [{}, "leases list unavailable"],
      [
        {
          leases: [
            {
              lease: {
                id: { dseq: "A" },
                price: { denom: "uact", amount: "nope" },
              },
            },
          ],
        },
        "lease price invalid",
      ],
      [
        {
          leases: [
            {
              lease: {
                id: { dseq: "A" },
                price: { denom: "uakt", amount: "5" },
              },
            },
          ],
        },
        "unsupported lease denom uakt",
      ],
      [
        {
          leases: [
            {
              lease: {
                id: { dseq: "A" },
                price: { denom: "wei", amount: "5" },
              },
            },
          ],
        },
        "lease price denom unknown",
      ],
      [
        {
          leases: [
            {
              lease: {
                id: { dseq: "A" },
                price: { denom: "uact", amount: "1" },
              },
            },
          ],
          pagination: { next_key: "abc" },
        },
        "coverage incomplete · more pages than read",
      ],
    ];
    for (const [leases, detail] of cases) {
      const row = await akashCreditReader({
        owner: "x",
        fetch: withLeases(leases),
        blocksPerDay: null,
      }).read(signal);
      expect(row).toMatchObject({
        grade: "UNKNOWN",
        reasonCode: "unreadable",
        detail,
        balance: null,
        burnPerDay: null,
      });
    }
    const missingDeployments = await akashCreditReader({
      owner: "x",
      blocksPerDay: null,
      fetch: async (url: string) => ({
        ok: true,
        status: 200,
        json: async () =>
          url.includes("/authz/")
            ? grant
            : url.includes("/deployments/")
              ? {}
              : { leases: [] },
      }),
    }).read(signal);
    expect(missingDeployments).toMatchObject({
      grade: "UNKNOWN",
      detail: "deployments list unavailable",
    });
    const verifiedEmpty = await akashCreditReader({
      owner: "x",
      fetch: withLeases({ leases: [] }),
      blocksPerDay: null,
    }).read(signal);
    expect(verifiedEmpty).toMatchObject({
      grade: "GREEN",
      burnPerDay: 0,
      detail: "no priced lease",
    });
  });
  it("follows pagination keys across pages and stops after the cap", async () => {
    const signal = new AbortController().signal;
    const grant = {
      grants: [
        {
          authorization: {
            "@type": "/akash.deployment.v1beta3.DepositAuthorization",
            spend_limits: [{ denom: "uact", amount: "0" }],
          },
        },
      ],
    };
    const seen: string[] = [];
    const fetch = async (url: string) => {
      seen.push(url);
      const page = Number(
        new URL(url).searchParams.get("pagination.key") ?? "0"
      );
      return {
        ok: true,
        status: 200,
        json: async () =>
          url.includes("/authz/")
            ? grant
            : url.includes("/deployments/")
              ? {
                  deployments: [
                    {
                      deployment: { id: { dseq: "A" } },
                      escrow_account: {
                        state: {
                          funds: [{ denom: "uact", amount: "3000000" }],
                        },
                      },
                    },
                  ],
                  pagination: { next_key: "" },
                }
              : {
                  leases: [
                    {
                      lease: {
                        id: { dseq: "A" },
                        price: { denom: "uact", amount: "1" },
                      },
                    },
                  ],
                  pagination: { next_key: page < 2 ? String(page + 1) : "" },
                },
      };
    };
    const row = await akashCreditReader({
      owner: "x",
      fetch,
      blocksPerDay: 1e6,
    }).read(signal);
    expect(seen.filter((u) => u.includes("/leases/"))).toHaveLength(3);
    expect(row.burnPerDay).toBeCloseTo(3, 9);
    expect(row.runwayDays).toBeCloseTo(1, 9);
  });
  it("grades an exhausted uakt-only grant as escrow-only balance and never throws from the chain read", async () => {
    const signal = new AbortController().signal;
    const exhausted = async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.includes("/authz/")
          ? {
              grants: [
                {
                  authorization: {
                    "@type": "/akash.deployment.v1beta3.DepositAuthorization",
                    spend_limits: [{ denom: "uakt", amount: "0" }],
                  },
                },
              ],
            }
          : url.includes("/deployments/")
            ? {
                deployments: [
                  {
                    deployment: { id: { dseq: "1" } },
                    escrow_account: {
                      state: { funds: [{ denom: "uact", amount: "2100000" }] },
                    },
                  },
                ],
              }
            : { leases: [] },
    });
    const escrowOnly = await akashCreditReader({
      owner: "x",
      fetch: exhausted,
      blocksPerDay: null,
    }).read(signal);
    expect(escrowOnly).toMatchObject({
      grade: "GREEN",
      detail: "no priced lease",
      parts: [
        { label: "Console credit", amount: "0", currency: "uact" },
        { label: "Escrow", amount: "2100000", currency: "uact" },
      ],
    });
    expect(escrowOnly.balance).toBeCloseTo(2.1, 9);
    const row = await akashCreditReader({
      owner: "x",
      blocksPerDay: null,
      payAction: {
        kind: "external",
        url: "https://console.akash.network/",
        label: "Top up",
      },
      fetch: async () => {
        throw new Error("sensitive-token-value");
      },
    }).read(signal);
    expect(row).toMatchObject({
      grade: "UNKNOWN",
      reasonCode: "unreadable",
      detail: "Akash chain read failed",
      balance: null,
      payer: "Operator",
      payAction: { kind: "external", url: "https://console.akash.network/" },
    });
    expect(JSON.stringify(row)).not.toContain("sensitive-token-value");
    expect(
      await akashCreditReader({
        owner: "x",
        blocksPerDay: null,
        fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
      }).read(signal)
    ).toMatchObject({
      reasonCode: "unreadable",
      detail: "Akash chain read failed",
    });
    expect(
      await akashCreditReader({
        owner: "x",
        blocksPerDay: null,
        fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
      }).read(signal)
    ).toMatchObject({
      reasonCode: "unreadable",
      detail: "no Console credit grant",
    });
    expect(
      sumUact([
        { denom: "uact", amount: "1" },
        { denom: "uakt", amount: "9" },
        { denom: "uact", amount: "x" },
      ])
    ).toBe(1);
  });
  it("measures blocks per day from the chain tip and falls back to null", async () => {
    const tip = "2026-10-26T12:00:00Z";
    const fetch = async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.endsWith("/blocks/latest")
          ? { block: { header: { height: "20000", time: tip } } }
          : { block: { header: { time: "2026-10-25T19:39:20Z" } } },
    });
    expect(await readAkashBlocksPerDay(fetch)).toBeCloseTo(
      (86_400 * 10_000) / 58_840,
      6
    );
    expect(
      await readAkashBlocksPerDay(async () => {
        throw new Error("down");
      })
    ).toBeNull();
  });
  it("ports cherryPlane: team credit, €/h × 24 burn and vendor remaining time → runway", async () => {
    const signal = new AbortController().signal;
    const calls: { url: string; headers?: Record<string, string> }[] = [];
    const fetch = async (
      url: string,
      init?: { headers?: Record<string, string> }
    ) => {
      calls.push({ url, ...(init?.headers ? { headers: init.headers } : {}) });
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            id: 183728,
            credit: {
              account: { remaining: 12.4, currency: "EUR" },
              resources: {
                pricing: { price: 0.0143 },
                remaining: { time: 864 },
              },
            },
          },
        ],
      };
    };
    const row = await cherryFinanceReader({
      token: "tok",
      teamId: "183728",
      fetch,
    }).read(signal);
    expect(calls[0]).toMatchObject({
      url: "https://api.cherryservers.com/v1/teams",
      headers: { Authorization: "Bearer tok", Accept: "application/json" },
    });
    expect(row).toMatchObject({
      plane: "cherry:team",
      label: "Cherry credit",
      kind: "prepaid",
      balance: 12.4,
      currency: "EUR",
      runwayDays: 36,
      grade: "GREEN",
      rail: { kind: "steward-manual", status: "supported" },
    });
    expect(row.burnPerDay).toBeCloseTo(0.3432, 9);
    expect(
      await cherryFinanceReader({
        token: undefined,
        teamId: "183728",
        fetch,
      }).read(signal)
    ).toMatchObject({
      grade: "UNKNOWN",
      reasonCode: "unconfigured",
      detail: "no Cherry credential in this runtime",
    });
    const thrown = await cherryFinanceReader({
      token: "tok",
      teamId: "183728",
      fetch: async () => {
        throw new Error("sensitive-token-value");
      },
    }).read(signal);
    expect(thrown).toMatchObject({
      grade: "UNKNOWN",
      reasonCode: "unreadable",
    });
    expect(JSON.stringify(thrown)).not.toContain("sensitive-token-value");
    expect(
      await cherryFinanceReader({
        token: "tok",
        teamId: "1",
        fetch: async () => ({
          ok: true,
          status: 200,
          json: async () => [
            { id: 1, credit: { account: { remaining: 3, currency: "EUR" } } },
          ],
        }),
      }).read(signal)
    ).toMatchObject({
      balance: 3,
      grade: "UNKNOWN",
      reasonCode: "burn_unmeasured",
    });
  });
  it("binds Cherry to the configured team: reordering teams does not change the result, missing config is UNKNOWN", async () => {
    const signal = new AbortController().signal;
    const green = {
      id: 100,
      credit: {
        account: { remaining: 100, currency: "EUR" },
        resources: { pricing: { price: 1 / 24 }, remaining: { time: 2400 } },
      },
    };
    const red = {
      id: 200,
      credit: {
        account: { remaining: 1, currency: "EUR" },
        resources: { pricing: { price: 1 / 24 }, remaining: { time: 24 } },
      },
    };
    const teams = (order: unknown[]) => async () => ({
      ok: true,
      status: 200,
      json: async () => order,
    });
    for (const order of [
      [green, red],
      [red, green],
    ]) {
      const row = await cherryFinanceReader({
        token: "tok",
        teamId: "200",
        fetch: teams(order),
      }).read(signal);
      expect(row).toMatchObject({ balance: 1, runwayDays: 1, grade: "RED" });
    }
    expect(
      await cherryFinanceReader({
        token: "tok",
        teamId: undefined,
        fetch: teams([green, red]),
      }).read(signal)
    ).toMatchObject({
      grade: "UNKNOWN",
      reasonCode: "unconfigured",
      detail: "Cherry team not configured",
    });
    expect(
      await cherryFinanceReader({
        token: "tok",
        teamId: "999",
        fetch: teams([green, red]),
      }).read(signal)
    ).toMatchObject({
      grade: "UNKNOWN",
      reasonCode: "unconfigured",
      detail: "configured team not found",
    });
  });
  it("reads Grafana month-to-date overage and averages it over UTC days elapsed", async () => {
    const signal = new AbortController().signal;
    expect(overagePerDay(252.65, new Date("2026-10-26T13:40:00Z"))).toBeCloseTo(
      252.65 / 26,
      9
    );
    expect(overagePerDay(10, new Date("2026-11-01T00:30:00Z"))).toBe(10);
    const urls: string[] = [];
    const fetch = async (
      url: string,
      init?: { headers?: Record<string, string> }
    ) => {
      urls.push(url);
      expect(init?.headers?.Authorization).toBe("Bearer sa-token");
      const total =
        decodeURIComponent(url.split("query=")[1] ?? "") ===
        "grafanacloud_org_total_overage";
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            result: total
              ? [
                  {
                    metric: { __name__: "grafanacloud_org_total_overage" },
                    value: [1, "252.65"],
                  },
                ]
              : [
                  {
                    metric: { __name__: "grafanacloud_org_logs_overage" },
                    value: [1, "180.1"],
                  },
                  {
                    metric: { __name__: "grafanacloud_org_total_overage" },
                    value: [1, "252.65"],
                  },
                  {
                    metric: { __name__: "grafanacloud_org_metrics_overage" },
                    value: [1, "60.55"],
                  },
                ],
          },
        }),
      };
    };
    const row = await grafanaOverageReader({
      url: "https://g.example/",
      token: "sa-token",
      fetch,
      now: () => new Date("2026-10-26T13:40:00Z"),
    }).read(signal);
    expect(urls[0]).toBe(
      "https://g.example/api/datasources/proxy/uid/grafanacloud-usage/api/v1/query?query=grafanacloud_org_total_overage"
    );
    expect(row).toMatchObject({
      plane: "grafana:overage",
      kind: "usage",
      balance: null,
      currency: "USD",
      grade: "INFO",
      label: "Grafana overage",
      source: "Grafana Cloud usage metrics · verify against invoice",
      detail: "252.65 USD month to date · day 26",
      rail: { kind: "card-manual", status: "planned", guide: "auto-bill" },
    });
    expect(row.children?.map((c) => [c.label, c.burnPerDay])).toEqual([
      ["Grafana · logs", 180.1 / 26],
      ["Grafana · metrics", 60.55 / 26],
    ]);
    expect(row.burnPerDay).toBeCloseTo(252.65 / 26, 9);
    expect(
      await grafanaOverageReader({ url: undefined, token: "x", fetch }).read(
        signal
      )
    ).toMatchObject({
      grade: "UNKNOWN",
      reasonCode: "unconfigured",
      detail: "no Grafana credential",
    });
    expect(
      await grafanaOverageReader({
        url: "https://g.example",
        token: "x",
        fetch: async () => {
          throw new Error("sensitive-token-value");
        },
      }).read(signal)
    ).toMatchObject({
      grade: "UNKNOWN",
      reasonCode: "unreadable",
      detail: "Grafana usage read failed",
    });
  });
  it("parses the RDAP expiration event into graded days left", async () => {
    const signal = new AbortController().signal;
    const now = new Date("2026-10-26T13:40:00Z");
    const events = [
      { eventAction: "registration", eventDate: "2024-04-05T13:40:00Z" },
      { eventAction: "expiration", eventDate: "2027-04-05T13:40:00Z" },
    ];
    expect(expiryDays(events, now)).toBeCloseTo(161, 9);
    expect(
      expiryDays([{ eventAction: "expiration", eventDate: "soon" }], now)
    ).toBeNull();
    expect(expiryDays(undefined, now)).toBeNull();
    const urls: string[] = [];
    const row = await domainExpiryReader({
      domain: "cognidao.org",
      now: () => now,
      fetch: async (url: string) => {
        urls.push(url);
        return { ok: true, status: 200, json: async () => ({ events }) };
      },
    }).read(signal);
    expect(urls).toEqual(["https://rdap.org/domain/cognidao.org"]);
    expect(row).toMatchObject({
      plane: "domain:cognidao.org",
      label: "Domain cognidao.org",
      kind: "expiry",
      balance: null,
      burnPerDay: null,
      grade: "GREEN",
      source: "RDAP registry record",
      detail: "expires 2027-04-05",
    });
    expect(row.runwayDays).toBeCloseTo(161, 9);
    expect(
      await domainExpiryReader({
        domain: "cognidao.org",
        now: () => now,
        fetch: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            events: [
              { eventAction: "expiration", eventDate: "2026-11-05T00:00:00Z" },
            ],
          }),
        }),
      }).read(signal)
    ).toMatchObject({ grade: "RED" });
    expect(
      await domainExpiryReader({
        domain: "cognidao.org",
        fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
      }).read(signal)
    ).toMatchObject({
      grade: "UNKNOWN",
      reasonCode: "unreadable",
      detail: "registry read failed",
    });
  });
  it("deduplicates one Base account across roles before reads, retaining missing roles", () => {
    const account = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
    const input = [
      {
        name: "treasury",
        isTreasury: true,
        label: "Treasury",
        address: account,
      },
      {
        name: "steward",
        label: "Steward",
        address: `0x${account.slice(2).toUpperCase()}`,
      },
      { name: "missing-a", label: "Missing A", address: undefined },
      { name: "missing-b", label: "Missing B", address: undefined },
    ];
    const result = uniqueWalletBindings(input);
    expect(result.map((row) => row.name)).toEqual([
      "treasury",
      "missing-a",
      "missing-b",
    ]);
    expect(result[0]?.label).toBe("Treasury · Steward");
    expect(
      uniqueWalletBindings([
        { name: "a", label: "A", address: account },
        {
          name: "b",
          label: "B",
          address: account,
          payAction: { kind: "fund-steward" },
          note: "chain",
        },
      ])[0]
    ).toMatchObject({ payAction: { kind: "fund-steward" }, note: "chain" });
    expect(
      uniqueWalletBindings([...input].reverse()).find((row) => row.isTreasury)
        ?.name
    ).toBe("steward");
    expect(input[0]?.label).toBe("Treasury");
  });
  it("composes wallets, OpenRouter, Cherry and Akash in order and reads a shared address once", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request) => ({
      ok: true,
      status: 200,
      json: async () => ({ result: "0x989680" }),
    }));
    vi.stubGlobal("fetch", fetch);
    const { readers, treasuryPlane } = await createFinanceReaders();
    expect(treasuryPlane).toBe("base:dao-treasury");
    expect(readers.map((reader) => reader.plane)).toEqual([
      "income:credit-purchases",
      "income:node-services",
      "base:dao-treasury",
      "openrouter:account",
      "cherry:team",
      "akash:credit",
      "akash:fleet",
      "grafana:overage",
      "domain:cognidao.org",
      "rpc:alchemy",
      "tenant:system",
      "saas:other",
    ]);
    const snapshot = await takeSnapshot(readers, { timeoutMs: 500 });
    const byPlane = new Map(snapshot.rows.map((row) => [row.plane, row]));
    expect(byPlane.get("income:credit-purchases")).toMatchObject({
      kind: "income",
      grade: "INFO",
      burnPerDay: 0,
      rail: { kind: "split-inflow", status: "supported" },
    });
    expect(byPlane.get("income:node-services")).toMatchObject({
      kind: "income",
      grade: "UNKNOWN",
      rail: { kind: "x402-auto", status: "planned" },
    });
    expect(byPlane.get("base:dao-treasury")).toMatchObject({
      label: "DAO treasury · Operator wallet · Steward wallet",
      balance: 10,
      currency: "USDC",
      grade: "INFO",
      payAction: { kind: "fund-steward" },
      rail: { kind: "steward-manual", status: "supported" },
      note: "User payments → operator wallet → steward wallet → vendors",
    });
    expect(byPlane.get("openrouter:account")).toMatchObject({
      rail: { kind: "steward-manual", status: "supported" },
      payAction: { kind: "steward-checkout", vendor: "openrouter" },
    });
    expect(byPlane.get("cherry:team")).toMatchObject({
      rail: { kind: "steward-manual", status: "supported" },
      payAction: { kind: "steward-checkout", vendor: "cherry" },
    });
    expect(byPlane.get("akash:credit")).toMatchObject({
      label: "Akash",
      rail: { kind: "card-manual", status: "planned", guide: "Console" },
      payAction: { kind: "external", url: "https://console.akash.network/" },
    });
    expect(byPlane.get("grafana:overage")?.rail).toEqual({
      kind: "card-manual",
      status: "planned",
      guide: "auto-bill",
    });
    expect(byPlane.get("domain:cognidao.org")?.rail?.kind).toBe("card-manual");
    for (const plane of ["rpc:alchemy", "tenant:system", "saas:other"])
      expect(byPlane.get(plane)?.rail).toEqual({
        kind: "none",
        status: "unsupported",
      });
    expect(byPlane.get("saas:other")?.children?.map((c) => c.label)).toEqual([
      "PostHog",
      "Langfuse",
      "Tavily",
      "GitHub",
      "DoltHub",
      "SonarCloud",
      "Privy",
    ]);
    expect(
      fetch.mock.calls.filter(
        (call) => String(call[0]) === "https://rpc.example"
      )
    ).toHaveLength(2);
    expect(
      fetch.mock.calls.filter((call) =>
        String(call[0]).startsWith(
          `https://api.akashnet.net/cosmos/authz/v1beta1/grants/grantee/${AKASH_PRODUCTION_OWNER}`
        )
      )
    ).toHaveLength(1);
    expect(snapshot.rows[5]).toMatchObject({
      plane: "akash:credit",
      grade: "UNKNOWN",
      reasonCode: "unreadable",
    });
    expect(snapshot.rows[3]).toMatchObject({
      label: "OpenRouter credit",
      grade: "UNKNOWN",
      reasonCode: "unconfigured",
      detail: "needs a management key · task.5361",
      rail: { kind: "steward-manual", status: "supported" },
      payAction: { kind: "steward-checkout", vendor: "openrouter" },
    });
    expect(
      fetch.mock.calls.some((call) => String(call[0]).includes("openrouter.ai"))
    ).toBe(false);
    expect(runtime.report).toHaveBeenCalledTimes(1);
    expect(snapshot.rows.map((row) => row.grade)).not.toContain("GREEN");
    expect(
      fetch.mock.calls.filter(
        (call) => new URL(String(call[0])).hostname === "rdap.org"
      )
    ).toHaveLength(1);
  });
  it("never calls OpenRouter with the inference key, scopes the Akash read to the configured account, and leaves wallets unreadable without an RPC", async () => {
    runtime.env = {
      OPENROUTER_API_KEY: "sk-test",
      AKASH_ACTUATOR_ACCOUNT_ID: "akash1custom",
    };
    const fetch = vi.fn(async (_url: string | URL | Request) => ({
      ok: true,
      status: 200,
      json: async () => ({ result: "0x0" }),
    }));
    vi.stubGlobal("fetch", fetch);
    const { readers } = await createFinanceReaders();
    const snapshot = await takeSnapshot(readers, { timeoutMs: 500 });
    expect(snapshot.rows[2]).toMatchObject({
      kind: "wallet",
      grade: "UNKNOWN",
      reasonCode: "unreadable",
      detail: "RPC unavailable",
    });
    expect(
      fetch.mock.calls.some((call) =>
        String(call[0]).includes("/grants/grantee/akash1custom")
      )
    ).toBe(true);
    expect(
      fetch.mock.calls.some((call) => String(call[0]).includes("openrouter.ai"))
    ).toBe(false);
  });
  it("bounds the Akash cadence probe: a hung LCD falls back to 5.884 s/block within the budget and keeps every row", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/blocks/"))
        return new Promise<never>((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("AbortError"))
          );
        });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ result: "0x989680" }),
      });
    });
    vi.stubGlobal("fetch", fetch);
    const pending = createFinanceReaders();
    let settled = false;
    pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const { readers } = await pending;
    expect(readers.map((r) => r.plane)).toContain("akash:credit");
    expect(readers.map((r) => r.plane)).toContain("base:dao-treasury");
    vi.useRealTimers();
  });
});
