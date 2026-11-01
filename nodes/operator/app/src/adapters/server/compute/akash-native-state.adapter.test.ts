// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `akash-native-state.adapter.test`
 * Purpose: Public LCD seam regressions from Akash 2.1.0 / chain-sdk 23a32e89.
 * Scope: Injected HTTP fixtures only; no network, credentials or paid actions.
 * Invariants: full identity, honest partial evidence, lossless uint64 and bounded work.
 * Side-effects: fake timers scoped to individual cases.
 * Links: bug.5556
 * @internal
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AkashNativeStateReader } from "./akash-native-state.adapter";

const OWNER = "akash1owner";
const DSEQ = "18446744073709551615";
const deployment = (
  state: unknown = "active",
  owner = OWNER,
  dseq: unknown = DSEQ
) => ({ deployment: { id: { owner, dseq }, state } });
const lease = (
  state: unknown = "active",
  id: Record<string, unknown> = {}
) => ({
  lease: {
    id: {
      owner: OWNER,
      dseq: DSEQ,
      gseq: 1,
      oseq: 1,
      provider: "akash1provider",
      bseq: 0,
      ...id,
    },
    state,
  },
});
const page = (leases: unknown[] = [lease()], next_key: unknown = null) => ({
  leases,
  pagination: { next_key, total: "0" },
});
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });
const fixture = (
  leaseBody: unknown = page(),
  deploymentBody: unknown = deployment()
) =>
  vi.fn(async (url: string | URL | Request) =>
    json(String(url).includes("deployments/info") ? deploymentBody : leaseBody)
  );
const read = (
  fetcher: typeof fetch,
  dseqs = [DSEQ],
  owner: string | undefined = OWNER
) => new AkashNativeStateReader(owner, fetcher).readMany({ dseqs });

afterEach(() => vi.useRealTimers());

describe("Akash native state — public read contract", () => {
  it("preserves bseq 0, uint64 max and full identities; deduplicates; uses only fixed public GETs", async () => {
    const fetcher = fixture();
    const result = (await read(fetcher, [DSEQ, DSEQ]))[DSEQ];
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      deploymentState: "active",
      deploymentCoverage: "complete",
      leaseCoverage: "complete",
      errorCode: null,
      leaseStates: [
        {
          id: {
            owner: OWNER,
            dseq: DSEQ,
            gseq: 1,
            oseq: 1,
            provider: "akash1provider",
            bseq: 0,
          },
          state: "active",
        },
      ],
    });
    expect(result?.observedAt).toEqual(expect.any(String));
    for (const [url, init] of fetcher.mock.calls as unknown as [
      URL,
      RequestInit,
    ][]) {
      expect(url.origin).toBe("https://api.akashnet.net");
      expect(init).toMatchObject({
        method: "GET",
        redirect: "error",
        credentials: "omit",
      });
      expect(init.headers).toBeUndefined();
      expect(init.body).toBeUndefined();
      expect(
        url.searchParams.get("id.dseq") ?? url.searchParams.get("filters.dseq")
      ).toBe(DSEQ);
      expect(url.searchParams.has("filters.state")).toBe(false);
    }
  });

  it.each([
    [1, "active"],
    [2, "insufficient_funds"],
    [3, "closed"],
    [4, "reclaiming"],
    ["reclaiming", "reclaiming"],
  ])("maps known lease state %s without a Console/closure verdict", async (state, expected) => {
    const result = (await read(fixture(page([lease(state)]))))[DSEQ];
    expect(result?.leaseStates[0]?.state).toBe(expected);
    expect(result).not.toHaveProperty("closure");
  });

  it.each([
    page([lease("active", { owner: "foreign" })]),
    page([lease("active", { dseq: "123" })]),
    page([lease("active", { bseq: undefined })]),
    page([lease("active", { provider: undefined })]),
    page([lease("active", { dseq: Number(DSEQ) })]),
    page([lease("invalid")]),
    page([lease("future_state")]),
    { leases: [lease()] },
    page([lease()], 123),
    page([lease()], "not base64!"),
  ])("does not claim malformed/mismatched lease evidence is complete", async (body) => {
    const result = (await read(fixture(body)))[DSEQ];
    expect(result?.leaseCoverage).not.toBe("complete");
    expect(result?.deploymentCoverage).toBe("complete");
    expect(result?.errorCode).not.toBeNull();
  });

  it.each([
    deployment("invalid"),
    deployment("active", "foreign"),
    deployment("active", OWNER, "18446744073709551616"),
  ])("keeps valid leases independent of an invalid deployment", async (body) => {
    const result = (await read(fixture(page(), body)))[DSEQ];
    expect(result?.deploymentState).toBeNull();
    expect(result?.deploymentCoverage).toBe("unknown");
    expect(result?.leaseCoverage).toBe("complete");
  });

  it("follows next_key, never total, and retains providers/bseq on two pages", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const u = new URL(String(url));
      if (u.pathname.includes("deployments/info"))
        return json(deployment("closed"));
      expect(u.searchParams.get("pagination.limit")).toBe("100");
      return json(
        u.searchParams.has("pagination.key")
          ? page([lease("closed", { provider: "akash1other", bseq: 8 })], "")
          : page([lease()], "YQ==")
      );
    });
    const result = (await read(fetcher))[DSEQ];
    expect(result?.leaseStates).toHaveLength(2);
    expect(result?.leaseStates[1]?.id.bseq).toBe(8);
    expect(result?.leaseCoverage).toBe("complete");
    expect(result?.leasePages).toHaveLength(2);
  });

  it.each([
    "YQ==",
    "Yg==",
  ])("bounds repeated cursors or further continuation %s as partial", async (second) => {
    let count = 0;
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("deployments/info")
        ? json(deployment())
        : json(
            page(
              [lease("active", { bseq: count })],
              ++count === 1 ? "YQ==" : second
            )
          )
    );
    const result = (await read(fetcher))[DSEQ];
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(result?.leaseCoverage).toBe("partial");
  });

  it("discards conflicting full-identity observations without claiming complete coverage", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const u = new URL(String(url));
      if (u.pathname.includes("deployments/info")) return json(deployment());
      return json(
        u.searchParams.has("pagination.key")
          ? page([lease("closed")])
          : page([lease("active")], "YQ==")
      );
    });
    const result = (await read(fetcher))[DSEQ];
    expect(result?.leaseCoverage).toBe("partial");
    expect(result?.leaseStates).toEqual([]);
    expect(result?.errorCode).toBe("conflicting_read");
    expect(result?.deploymentCoverage).toBe("complete");
  });

  it.each([
    ["first", true],
    ["first", false],
    ["second", true],
    ["second", false],
  ] as const)("records retained evidence and its window after a %s-page conflict (deployment valid: %s)", async (conflictPage, validDeployment) => {
    vi.useFakeTimers();
    const deploymentTime = "2026-10-31T02:30:00.000Z";
    const firstPageTime = "2026-10-31T02:30:01.000Z";
    const secondPageTime = "2026-10-31T02:30:02.000Z";
    const unrelated = lease("reclaiming", {
      provider: "akash1unrelated",
      bseq: 7,
    });
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const u = new URL(String(url));
      if (u.pathname.includes("deployments/info")) {
        vi.setSystemTime(new Date(deploymentTime));
        return validDeployment
          ? json(deployment())
          : new Response("unavailable", { status: 503 });
      }
      const secondPage = u.searchParams.has("pagination.key");
      vi.setSystemTime(new Date(secondPage ? secondPageTime : firstPageTime));
      if (conflictPage === "first")
        return json(page([lease("active"), unrelated, lease("closed")]));
      return json(
        secondPage
          ? page([unrelated, lease("closed")])
          : page([lease("active")], "YQ==")
      );
    });
    const result = (await read(fetcher))[DSEQ];
    const retainedTime =
      conflictPage === "first" ? firstPageTime : secondPageTime;
    expect(fetcher).toHaveBeenCalledTimes(conflictPage === "first" ? 2 : 3);
    expect(result).toMatchObject({
      deploymentCoverage: validDeployment ? "complete" : "unknown",
      deploymentObservedAt: validDeployment ? deploymentTime : null,
      leaseCoverage: "partial",
      errorCode: "conflicting_read",
      observedAt: retainedTime,
    });
    // A is excluded; unrelated B survives with its actual response time and full identity.
    expect(result?.leaseStates).toEqual([
      { id: unrelated.lease.id, state: "reclaiming", observedAt: retainedTime },
    ]);
    expect(result?.leasePages).toEqual(
      conflictPage === "first"
        ? [{ observedAt: firstPageTime, count: 3 }]
        : [
            { observedAt: firstPageTime, count: 1 },
            { observedAt: secondPageTime, count: 2 },
          ]
    );
    for (const evidence of result?.leaseStates ?? []) {
      expect(
        result?.leasePages.some((p) => p.observedAt === evidence.observedAt)
      ).toBe(true);
      expect(Date.parse(result?.observedAt ?? "")).toBeGreaterThanOrEqual(
        Date.parse(evidence.observedAt)
      );
    }
  });

  it("retains first-page evidence after the second page fails", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const u = new URL(String(url));
      if (u.pathname.includes("deployments/info")) return json(deployment());
      return u.searchParams.has("pagination.key")
        ? new Response("unavailable", { status: 503 })
        : json(page([lease()], "YQ=="));
    });
    const result = (await read(fetcher))[DSEQ];
    expect(result?.leaseCoverage).toBe("partial");
    expect(result?.leaseStates).toHaveLength(1);
    expect(result?.deploymentCoverage).toBe("complete");
  });

  it("404 is unknown, never proof of absence or closure", async () => {
    const fetcher = vi.fn(async () => new Response("missing", { status: 404 }));
    const result = (await read(fetcher))[DSEQ];
    expect(result).toMatchObject({
      deploymentState: null,
      deploymentCoverage: "unknown",
      leaseCoverage: "unknown",
      errorCode: "http_error",
    });
  });

  it("times out a stalled body read and propagates cancellation", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        signals.push(init?.signal as AbortSignal);
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('{"deployment":'));
            },
            cancel,
          })
        );
      }
    );
    const pending = read(fetcher);
    await vi.advanceTimersByTimeAsync(4001);
    const result = (await pending)[DSEQ];
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(cancel).toHaveBeenCalled();
    expect(result?.errorCode).toBe("timeout");
  });

  it("caps two concurrent handles and an eight-second native budget, including queued work", async () => {
    vi.useFakeTimers();
    let inFlight = 0;
    let max = 0;
    const fetcher = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          inFlight++;
          max = Math.max(max, inFlight);
          init?.signal?.addEventListener(
            "abort",
            () => {
              inFlight--;
              reject(new Error("abort"));
            },
            { once: true }
          );
        })
    );
    const pending = read(
      fetcher,
      Array.from({ length: 50 }, (_, i) => String(i + 1))
    );
    await vi.advanceTimersByTimeAsync(8001);
    const result = await pending;
    expect(max).toBeLessThanOrEqual(2);
    expect(Object.keys(result)).toHaveLength(50);
    expect(
      Object.values(result).every((r) => r.leaseCoverage === "unknown")
    ).toBe(true);
    expect(
      Object.values(result).some((r) => r.errorCode === "budget_exceeded")
    ).toBe(true);
  });

  it("bounds body bytes before JSON parsing", async () => {
    const fetcher = vi.fn(
      async () => new Response("x".repeat(1024 * 1024 + 1))
    );
    const result = (await read(fetcher))[DSEQ];
    expect(result?.errorCode).toBe("response_too_large");
  });

  it("rejects invalid local handles and missing owner with no I/O or owner fallback", async () => {
    const fetcher = fixture();
    await read(fetcher, ["01", "-1", "18446744073709551616"]);
    await new AkashNativeStateReader(undefined, fetcher).readMany({
      dseqs: [DSEQ],
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("wallet ACTIVE inventory at one height", () => {
  const height = "30000000";
  const atHeight = (body: unknown, at: string | null = height) =>
    new Response(JSON.stringify(body), {
      headers: at ? { "x-cosmos-block-height": at } : {},
    });
  const withFreshBlock =
    (fetcher: typeof fetch): typeof fetch =>
    async (input, init) =>
      new URL(String(input)).pathname.includes("/blocks/")
        ? atHeight({
            block: { header: { height, time: new Date().toISOString() } },
          })
        : fetcher(input, init);
  const active = (dseq = DSEQ, owner = OWNER) => ({
    deployment: { id: { owner, dseq }, state: "active" },
    groups: [{ id: { owner, dseq, gseq: 1 }, state: "open" }],
  });
  const inventory = (rows: unknown[], next_key: string | null = null) => ({
    deployments: rows,
    pagination: { next_key },
  });

  it.each([
    "uniformly stale",
    "pre-start",
    "future",
    "fresh tip with stale page",
  ])("refuses %s consensus evidence before granting an empty inventory", async (kind) => {
    const now = Date.now();
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (new URL(String(input)).pathname.includes("/blocks/"))
        return atHeight({
          block: {
            header: {
              height,
              time: new Date(
                kind === "future"
                  ? now + 60_000
                  : kind === "uniformly stale"
                    ? now - 60_000
                    : kind === "pre-start"
                      ? now - 1000
                      : Date.now()
              ).toISOString(),
            },
          },
        });
      return atHeight(inventory([]), "29999999");
    });
    await expect(
      new AkashNativeStateReader(OWNER, fetcher).readWalletInventory({
        deadlineAt: now + 50,
      })
    ).rejects.toThrow(
      kind === "pre-start" ? /budget_exceeded|abort/i : "height_mismatch"
    );
    if (kind !== "fresh tip with stale page")
      expect(
        fetcher.mock.calls.every(([input]) =>
          new URL(String(input)).pathname.includes("/blocks/")
        )
      ).toBe(true);
  });

  it("exhausts real owner continuation and includes unleased open groups/orders", async () => {
    const requests: { url: URL; init?: RequestInit }[] = [];
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        requests.push({ url, ...(init ? { init } : {}) });
        if (url.pathname.includes("deployments/list"))
          return atHeight(
            url.searchParams.has("pagination.key")
              ? inventory([])
              : inventory([active()], "AQ==")
          );
        if (url.pathname.includes("orders/list"))
          return atHeight({
            orders: [
              {
                id: { owner: OWNER, dseq: DSEQ, gseq: 1, oseq: 1 },
                state: "open",
              },
            ],
            pagination: { next_key: null },
          });
        return atHeight({ leases: [], pagination: { next_key: null } });
      }
    );
    const result = await new AkashNativeStateReader(
      OWNER,
      withFreshBlock(fetcher)
    ).readWalletInventory({ deadlineAt: Date.now() + 30_000 });
    expect(result).toMatchObject({
      owner: OWNER,
      height,
      targets: [
        {
          dseq: DSEQ,
          groups: [{ gseq: 1, state: "open" }],
          orders: [{ gseq: 1, oseq: 1, state: "open" }],
          leases: [],
        },
      ],
    });
    expect(requests[0]?.url.searchParams.get("filters.owner")).toBe(OWNER);
    expect(requests[0]?.url.searchParams.get("filters.state")).toBe("active");
    expect(requests[1]?.url.searchParams.get("pagination.key")).toBe("AQ==");
    for (const request of requests)
      expect(
        new Headers(request.init?.headers).get("x-cosmos-block-height")
      ).toBe(height);
  });

  it.each([
    null,
    "29999999",
  ])("refuses absent/mixed response height %s", async (secondHeight) => {
    let calls = 0;
    const fetcher = vi.fn(async () =>
      atHeight(inventory([], "AQ=="), calls++ === 0 ? height : secondHeight)
    );
    await expect(
      new AkashNativeStateReader(
        OWNER,
        withFreshBlock(fetcher)
      ).readWalletInventory({
        deadlineAt: Date.now() + 30_000,
      })
    ).rejects.toThrow("height_mismatch");
  });

  it("does not call a repeated continuation complete", async () => {
    const fetcher = vi.fn(async () => atHeight(inventory([], "AQ==")));
    await expect(
      new AkashNativeStateReader(
        OWNER,
        withFreshBlock(fetcher)
      ).readWalletInventory({
        deadlineAt: Date.now() + 30_000,
      })
    ).rejects.toThrow("pagination_incomplete");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("refuses a foreign owner before reading its orders or leases", async () => {
    const fetcher = vi.fn(async () =>
      atHeight(inventory([active(DSEQ, "akash1foreign")]))
    );
    await expect(
      new AkashNativeStateReader(
        OWNER,
        withFreshBlock(fetcher)
      ).readWalletInventory({
        deadlineAt: Date.now() + 30_000,
      })
    ).rejects.toThrow("identity_mismatch");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("refuses closed/duplicate targets inside the ACTIVE response", async () => {
    for (const rows of [
      [
        {
          ...active(),
          deployment: { id: { owner: OWNER, dseq: DSEQ }, state: "closed" },
        },
      ],
      [active(), active()],
    ]) {
      const fetcher = vi.fn(async (input: string | URL | Request) =>
        atHeight(
          String(input).includes("deployments/list")
            ? inventory(rows)
            : String(input).includes("orders/list")
              ? { orders: [], pagination: { next_key: null } }
              : { leases: [], pagination: { next_key: null } }
        )
      );
      await expect(
        new AkashNativeStateReader(
          OWNER,
          withFreshBlock(fetcher)
        ).readWalletInventory({
          deadlineAt: Date.now() + 30_000,
        })
      ).rejects.toThrow("identity_mismatch");
    }
  });

  it("aborts expired queued work and rejects late responses from an uncooperative transport", async () => {
    const never = vi.fn(() => new Promise<Response>(() => undefined));
    await expect(
      new AkashNativeStateReader(
        OWNER,
        withFreshBlock(never)
      ).readWalletInventory({
        deadlineAt: Date.now() - 1,
      })
    ).rejects.toThrow("budget_exceeded");
    expect(never).not.toHaveBeenCalled();
    vi.useFakeTimers();
    const pending = new AkashNativeStateReader(
      OWNER,
      withFreshBlock(never)
    ).readWalletInventory({ deadlineAt: Date.now() + 50 });
    const assertion = expect(pending).rejects.toThrow("budget_exceeded");
    await vi.advanceTimersByTimeAsync(51);
    await assertion;
  });

  it("certifies only its pinned owner's exact own handle; absence never means CLOSED", async () => {
    const reader = new AkashNativeStateReader(
      OWNER,
      vi.fn(async () =>
        atHeight({
          deployment: { id: { owner: OWNER, dseq: DSEQ }, state: "closed" },
        })
      )
    );
    expect(
      await reader.readOwnClosed({
        dseq: DSEQ,
        deadlineAt: Date.now() + 30_000,
      })
    ).toEqual({ owner: OWNER, dseq: DSEQ, height, closed: true });
    await expect(
      new AkashNativeStateReader(
        OWNER,
        vi.fn(async () => atHeight({}))
      ).readOwnClosed({ dseq: DSEQ, deadlineAt: Date.now() + 30_000 })
    ).rejects.toThrow("invalid_response");
  });
});
