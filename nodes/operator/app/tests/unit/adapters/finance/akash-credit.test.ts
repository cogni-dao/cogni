// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `akash-credit.test`
 * Purpose: Verify available-credit estimates and fail-closed public chain evidence.
 * Scope: Reader and composed row with injected HTTP responses; no network or money.
 * Invariants: Escrow never inflates available credit; invalid evidence remains UNKNOWN.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/task.5347
 * @internal
 */
import { describe, expect, it } from "vitest";
import { akashCreditReader } from "@/adapters/server/finance/akash-credit.reader";
import { collapseAkash } from "@/adapters/server/finance/operator-finance.adapter";

const owner = "akash1owner";
const granter = "akash1console";
const grant = (amount = "96000000") => ({
  granter,
  grantee: owner,
  expiration: "2036-01-01T00:00:00Z",
  authorization: {
    "@type": "/akash.escrow.v1.DepositAuthorization",
    scopes: ["deployment"],
    spend_limit: { denom: "uakt", amount: "0" },
    spend_limits: [{ denom: "uact", amount }],
  },
});
const deployment = (dseq: string, amount: string) => ({
  deployment: { id: { dseq } },
  escrow_account: { state: { funds: [{ denom: "uact", amount }] } },
});
const lease = (dseq: string, amount = "1") => ({
  lease: { id: { dseq }, price: { denom: "uact", amount } },
});
function read({
  grants = { grants: [grant()] } as unknown,
  deployments = { deployments: [deployment("A", "4000000")] } as unknown,
  leases = { leases: [lease("A", "4")] } as unknown,
  nextGrants,
}: {
  grants?: unknown;
  deployments?: unknown;
  leases?: unknown;
  nextGrants?: unknown;
} = {}) {
  return akashCreditReader({
    owner,
    expectedGranter: granter,
    now: () => new Date("2026-10-27T00:00:00Z"),
    blocksPerDay: 1e6,
    fetch: async (url) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.includes("/authz/")
          ? url.includes("pagination.key=") && nextGrants
            ? nextGrants
            : grants
          : url.includes("/deployments/")
            ? deployments
            : leases,
    }),
  }).read(new AbortController().signal);
}

describe("Akash available credit", () => {
  it("keeps normal short escrow out of the account top-up grade", async () => {
    expect(await read()).toMatchObject({
      label: "Akash credit",
      balance: 96,
      burnPerDay: 4,
      runwayDays: 24,
      grade: "GREEN",
    });
  });
  it.each([
    "0",
    "1",
  ])("does not pool skewed escrow into %s micro-credits", async (amount) => {
    const row = await read({
      grants: { grants: [grant(amount)] },
      deployments: {
        deployments: [deployment("A", "1000000"), deployment("B", "99000000")],
      },
      leases: { leases: [lease("A"), lease("B")] },
    });
    expect(row).toMatchObject({
      balance: Number(amount) / 1e6,
      burnPerDay: 2,
      runwayDays: Number(amount) / 2e6,
      grade: "RED",
    });
    expect(row.source).toContain("Available Console credit · escrow excluded");
  });
  it("gives no-lease precedence over zero credit", async () => {
    expect(
      await read({
        grants: { grants: [grant("0")] },
        leases: { leases: [] },
        deployments: { deployments: [] },
      })
    ).toMatchObject({
      balance: 0,
      burnPerDay: 0,
      runwayDays: null,
      grade: "INFO",
      detail: "No active leases",
    });
  });
  it("follows a valid grant onto the second page", async () => {
    expect(
      await read({
        grants: { grants: [], pagination: { next_key: "next" } },
        nextGrants: { grants: [grant()] },
      })
    ).toMatchObject({ balance: 96, grade: "GREEN" });
  });
  it.each([
    [
      "wrong granter",
      (g: ReturnType<typeof grant>) => ({ ...g, granter: "akash1other" }),
    ],
    [
      "wrong grantee",
      (g: ReturnType<typeof grant>) => ({ ...g, grantee: "akash1other" }),
    ],
    [
      "expired",
      (g: ReturnType<typeof grant>) => ({
        ...g,
        expiration: "2020-01-01T00:00:00Z",
      }),
    ],
    [
      "invalid expiry",
      (g: ReturnType<typeof grant>) => ({ ...g, expiration: "bad" }),
    ],
    [
      "wrong type",
      (g: ReturnType<typeof grant>) => ({
        ...g,
        authorization: {
          ...g.authorization,
          "@type": "/fake.DepositAuthorization",
        },
      }),
    ],
    [
      "wrong scope",
      (g: ReturnType<typeof grant>) => ({
        ...g,
        authorization: { ...g.authorization, scopes: ["other"] },
      }),
    ],
    ["negative", () => grant("-1")],
    ["invalid amount", () => grant("NaN")],
    ["blank amount", () => grant("")],
    [
      "unsupported coin",
      (g: ReturnType<typeof grant>) => ({
        ...g,
        authorization: {
          ...g.authorization,
          spend_limits: [{ denom: "uakt", amount: "12" }],
        },
      }),
    ],
    [
      "nonzero legacy",
      (g: ReturnType<typeof grant>) => ({
        ...g,
        authorization: {
          ...g.authorization,
          spend_limit: { denom: "uakt", amount: "2" },
        },
      }),
    ],
  ] as const)("rejects %s and composition cannot restore safety", async (_name, mutate) => {
    const row = await read({ grants: { grants: [mutate(grant())] } });
    expect(row).toMatchObject({
      balance: null,
      runwayDays: null,
      grade: "UNKNOWN",
    });
    const [composed] = collapseAkash([
      row,
      {
        ...row,
        plane: "akash:node",
        kind: "fixed",
        burnPerDay: 1,
        grade: "INFO",
        reasonCode: undefined,
      },
    ]);
    expect(composed).toMatchObject({
      balance: null,
      runwayDays: null,
      grade: "UNKNOWN",
      reasonCode: "unreadable",
    });
  });
  it.each([
    { grants: [grant(), grant()] },
    { grants: [grant()], pagination: { next_key: "unending" } },
    { grants: [grant()], pagination: { next_key: 12 } },
    {},
  ])("rejects ambiguous or incomplete grant evidence %j", async (grants) => {
    expect(await read({ grants })).toMatchObject({
      grade: "UNKNOWN",
      balance: null,
    });
  });
  it.each([
    { deployments: [] },
    { deployments: [deployment("A", "1"), deployment("A", "2")] },
    { deployments: [deployment("A", "-1")] },
    { deployments: [deployment("A", "bad")] },
    { deployments: [{ deployment: { id: { dseq: "A" } } }] },
  ])("rejects missing or malformed escrow evidence %j", async (deployments) => {
    expect(await read({ deployments })).toMatchObject({
      grade: "UNKNOWN",
      balance: null,
    });
  });
});
