// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  AKASH_OVERCLOCK_AUDITOR,
  AkashComputeAdapter,
  AkashComputeError,
} from "./akash-compute.adapter";
import type { ProviderOutcomeStats } from "./akash-provider-screen";
import { buildAkashSdl } from "./akash-sdl";
import type {
  ProviderOutcomeRecord,
  ProviderOutcomeStore,
} from "./provider-outcome-store";

const BASE = "https://console-api.akash.network";
const SOURCE_SHA = "a".repeat(40);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** In-memory ProviderOutcomeStore with capture + presettable stats. */
function memStore(preset?: Map<string, ProviderOutcomeStats>) {
  const records: ProviderOutcomeRecord[] = [];
  const store: ProviderOutcomeStore = {
    record: async (rec) => {
      records.push(rec);
    },
    stats: async () => preset ?? new Map(),
  };
  return { records, store };
}

/** Console `/v1/providers` entry that passes the quality filter. */
function providerEntry(
  owner: string,
  over: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    owner,
    isAudited: true,
    isOnline: true,
    isValidVersion: true,
    uptime7d: 0.999,
    leaseCount: 5,
    ipCountryCode: "BE",
    ...over,
  };
}

function bidEntry(dseq: string, provider: string, amount: string) {
  return {
    bid: {
      id: { dseq, gseq: 1, oseq: 1, provider },
      state: "open",
      price: { denom: "uakt", amount },
    },
  };
}

interface HarnessOpts {
  /** Raw array served at GET /v1/providers (Console returns an unenveloped array). */
  providers?: unknown[];
  /** Bids per (dseq, poll wave). Default: none. */
  bids?: (dseq: string, wave: number) => unknown[];
  /** Which workload hosts answer /version with 200. Default: all. */
  serving?: (host: string) => boolean;
  /** Which workload hosts answer fixed /readyz with 2xx. Default: all. */
  ready?: (host: string) => boolean;
  /** Exact source revision returned by /version. Defaults to SOURCE_SHA. */
  versionSha?: (host: string) => string;
  /** Provider-reported endpoints for a deployment. Defaults to one public hostname. */
  endpoints?: (dseq: string) => readonly string[];
  /** Whether Console deployment status is readable. Defaults to true. */
  statusAvailable?: boolean;
}

/**
 * Routing fetch fake for the full provision flow. Deployments get dseq "1", "2", … in
 * creation order; each dseq's status reports endpoint `d<dseq>.prov.akash.pub`.
 */
function harness(opts: HarnessOpts = {}) {
  let nextDseq = 1;
  const waves = new Map<string, number>();
  const leased: { dseq: string; provider: string }[] = [];
  const deletes: string[] = [];
  const createBodies: { data: { sdl: string; deposit: number } }[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (u === `${BASE}/v1/providers`) {
      return jsonResponse(opts.providers ?? []);
    }
    if (u === `${BASE}/v1/deployments` && method === "POST") {
      createBodies.push(
        JSON.parse(String(init?.body)) as (typeof createBodies)[number]
      );
      const dseq = String(nextDseq++);
      return jsonResponse({ data: { dseq, manifest: [{ name: "dcloud" }] } });
    }
    if (u.startsWith(`${BASE}/v1/bids?dseq=`)) {
      const dseq = u.slice(`${BASE}/v1/bids?dseq=`.length);
      const wave = waves.get(dseq) ?? 0;
      waves.set(dseq, wave + 1);
      return jsonResponse({ data: opts.bids?.(dseq, wave) ?? [] });
    }
    if (u === `${BASE}/v1/leases` && method === "POST") {
      const body = JSON.parse(String(init?.body)) as {
        leases: { dseq: string; provider: string }[];
      };
      const lease = body.leases[0];
      if (lease) leased.push({ dseq: lease.dseq, provider: lease.provider });
      return jsonResponse({ data: {} });
    }
    if (method === "DELETE") {
      deletes.push(u);
      return jsonResponse({ data: { success: true } });
    }
    if (u.endsWith("/version")) {
      const host = new URL(u).host;
      const ok = opts.serving ? opts.serving(host) : true;
      return ok
        ? jsonResponse({ buildSha: opts.versionSha?.(host) ?? SOURCE_SHA })
        : new Response(null, { status: 503 });
    }
    if (u.endsWith("/readyz")) {
      const host = new URL(u).host;
      const ok = opts.ready ? opts.ready(host) : true;
      return new Response(null, { status: ok ? 204 : 503 });
    }
    const statusMatch = u.match(/\/v1\/deployments\/(\d+)$/);
    if (statusMatch) {
      if (opts.statusAvailable === false) {
        return jsonResponse({ error: "unavailable" }, 503);
      }
      const dseq = statusMatch[1];
      if (!dseq) throw new Error(`missing dseq in ${u}`);
      const endpoints = opts.endpoints?.(dseq) ?? [`d${dseq}.prov.akash.pub`];
      return jsonResponse({
        data: {
          deployment: { state: "active" },
          leases: [
            {
              state: "active",
              status: {
                services: { app: { uris: endpoints } },
              },
            },
          ],
        },
      });
    }
    throw new Error(`unhandled ${method} ${u}`);
  });
  return { fetchImpl, leased, deletes, createBodies, waves };
}

function makeAdapter(
  fetchImpl: typeof fetch,
  overrides: Partial<ConstructorParameters<typeof AkashComputeAdapter>[0]> = {}
): AkashComputeAdapter {
  return new AkashComputeAdapter({
    apiKey: "console-key",
    timeoutMs: 1000,
    bidTimeoutMs: 0,
    bidPollIntervalMs: 0,
    bootSloMs: 60_000,
    bootPollIntervalMs: 0,
    sleepImpl: async () => {},
    outcomeStore: memStore().store,
    fetchImpl,
    ...overrides,
  });
}

const SPEC = {
  name: "toks4",
  services: [
    {
      name: "app",
      image: "ghcr.io/cogni-dao/toks4:sha-abc",
      env: { PORT: "3000" },
      cpuUnits: 0.5,
      memoryMi: 1024,
      storageMi: 2048,
      expose: [
        { port: 3000, as: 80, global: true, hosts: ["toks4.example.org"] },
      ],
    },
    {
      name: "echo-sidecar",
      image: "ghcr.io/example/echo-sidecar@sha256:abc",
      command: ["node", "server.mjs"],
      args: ["--host", "0.0.0.0", "--port", "9100"],
      cpuUnits: 0.25,
      memoryMi: 512,
      storageMi: 1024,
      expose: [{ port: 9100, as: 9100, global: false }],
    },
  ],
} as const;

describe("buildAkashSdl", () => {
  it("renders services, profiles, placement pricing, and deployment sections", () => {
    const sdl = buildAkashSdl(SPEC, {
      pricingDenom: "uakt",
      pricingAmount: 10_000,
    });
    expect(sdl).toContain('version: "2.0"');
    expect(sdl).toContain("ghcr.io/cogni-dao/toks4:sha-abc");
    expect(sdl).toContain("PORT=3000");
    expect(sdl).toContain("toks4.example.org");
    expect(sdl).toContain("denom: uakt");
    // global expose on app; private sibling routes only to app by service name
    expect(sdl).toContain("global: true");
    expect(sdl).toContain("service: app");
    expect(sdl).not.toContain("service: echo-sidecar");
    const rendered = parseYaml(sdl) as {
      services: Record<
        string,
        { args?: string[]; expose?: { to: Record<string, unknown>[] }[] }
      >;
    };
    expect(rendered.services["echo-sidecar"]?.args).toEqual([
      "--host",
      "0.0.0.0",
      "--port",
      "9100",
    ]);
    expect(rendered.services["echo-sidecar"]?.expose?.[0]?.to).toEqual([
      { service: "app" },
    ]);
    expect(
      rendered.services["echo-sidecar"]?.expose?.[0]?.to
    ).not.toContainEqual({ global: true });
  });

  it("anchors placement signedBy.allOf to the given auditors", () => {
    const sdl = buildAkashSdl(SPEC, {
      pricingDenom: "uakt",
      pricingAmount: 10_000,
      auditors: [AKASH_OVERCLOCK_AUDITOR],
    });
    expect(sdl).toContain("signedBy");
    expect(sdl).toContain(AKASH_OVERCLOCK_AUDITOR);
  });

  it("omits signedBy when no auditors are configured", () => {
    const sdl = buildAkashSdl(SPEC, {
      pricingDenom: "uakt",
      pricingAmount: 10_000,
    });
    expect(sdl).not.toContain("signedBy");
  });
});

describe("AkashComputeAdapter", () => {
  it("maps the managed wallet's micro-unit allowance to a USD ComputeBalance", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("console-key");
      if (String(url) === `${BASE}/v1/user/me`) {
        return jsonResponse({ data: { id: "user-1" } });
      }
      expect(String(url)).toBe(`${BASE}/v1/wallets?userId=user-1`);
      return jsonResponse({
        data: [
          {
            id: 7,
            address: "akash1abc",
            creditAmount: 100_000_000,
            denom: "uusdc",
            isTrialing: true,
          },
        ],
      });
    });

    const balances = await makeAdapter(fetchImpl).balances();

    expect(balances).toEqual([
      expect.objectContaining({
        provider: "akash",
        accountId: "akash1abc",
        currency: "USD",
        remaining: 100,
        estimatedDaysRemaining: null,
      }),
    ]);
  });

  it("provisions: screens bids, leases, proves /version, records boot_ok", async () => {
    const h = harness({
      providers: [providerEntry("akash1exp"), providerEntry("akash1cheap")],
      bids: (dseq) => [
        bidEntry(dseq, "akash1exp", "900"),
        bidEntry(dseq, "akash1cheap", "150"),
      ],
    });
    const { records, store } = memStore();

    const out = await makeAdapter(h.fetchImpl, {
      outcomeStore: store,
    }).provision({ env: "shared", spec: SPEC });

    expect(out).toEqual({
      provider: "akash",
      leaseId: "1",
      state: "active",
      endpoints: ["d1.prov.akash.pub"],
    });
    expect(h.leased).toEqual([{ dseq: "1", provider: "akash1cheap" }]);
    // the posted SDL carries the deposit + the audited-only signedBy anchor by default
    expect(h.createBodies[0]?.data.deposit).toBe(0.5);
    expect(h.createBodies[0]?.data.sdl).toContain(AKASH_OVERCLOCK_AUDITOR);
    expect(records).toEqual([
      expect.objectContaining({
        computeProvider: "akash",
        providerAccount: "akash1cheap",
        outcome: "boot_ok",
        leaseId: "1",
        workload: "toks4",
      }),
    ]);
  });

  it("logs a structured error when the boot-outcome write fails, without failing the provision (bug.5128)", async () => {
    const h = harness({
      providers: [providerEntry("akash1cheap")],
      bids: (dseq) => [bidEntry(dseq, "akash1cheap", "150")],
    });
    const logError = vi.fn();
    const failingStore: ProviderOutcomeStore = {
      record: async () => {
        throw new Error("insert into compute_provider_outcomes failed");
      },
      stats: async () => new Map(),
    };

    const out = await makeAdapter(h.fetchImpl, {
      outcomeStore: failingStore,
      log: { error: logError },
    }).provision({ env: "t", spec: SPEC });

    expect(out.state).toBe("active");
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "ProviderOutcomeWriteFailed",
        computeProvider: "akash",
        providerAccount: "akash1cheap",
        outcome: "boot_ok",
        leaseId: "1",
        workload: "toks4",
        causeType: "Error",
        causeMessage: "insert into compute_provider_outcomes failed",
      }),
      "compute_provider_outcome_write_failed"
    );
  });

  it("throws NO_BIDS when the bid window elapses without an open bid", async () => {
    const h = harness();
    await expect(
      makeAdapter(h.fetchImpl).provision({ env: "shared", spec: SPEC })
    ).rejects.toMatchObject({ code: "NO_BIDS" });
    // deployment closed (escrow refunds)
    expect(h.deletes).toEqual([`${BASE}/v1/deployments/1`]);
  });

  it("maps a closed deployment's status and releases via DELETE", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === "DELETE") {
        expect(String(url)).toBe(`${BASE}/v1/deployments/42`);
        return jsonResponse({ data: { success: true } });
      }
      return jsonResponse({
        data: { deployment: { state: "closed" }, leases: [] },
      });
    });

    const adapter = makeAdapter(fetchImpl);
    const status = await adapter.status({ leaseId: "42" });
    expect(status.state).toBe("closed");
    expect(status.endpoints).toEqual([]);
    await expect(adapter.release({ leaseId: "42" })).resolves.toBeUndefined();
  });

  it("updates a known deployment in place with Console PUT and preserves its handle", async () => {
    let putBody: unknown;
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const value = String(url);
      if (value === `${BASE}/v1/deployments/42` && init?.method === "PUT") {
        putBody = JSON.parse(String(init.body));
        return jsonResponse({ data: { dseq: "42" } });
      }
      if (value === `${BASE}/v1/deployments/42`) {
        return jsonResponse({
          data: {
            deployment: { state: "active" },
            leases: [
              {
                state: "active",
                status: { uris: ["updated.prov.akash.pub"] },
              },
            ],
          },
        });
      }
      if (value === "http://updated.prov.akash.pub/version") {
        return jsonResponse({ buildSha: SOURCE_SHA });
      }
      if (value === "http://updated.prov.akash.pub/readyz") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unhandled ${init?.method ?? "GET"} ${value}`);
    });

    const output = await makeAdapter(fetchImpl).update({
      resourceId: "42",
      env: "candidate-a",
      spec: SPEC,
      expectedSourceSha: SOURCE_SHA,
      idempotencyKey: "durable-controller-key",
    });

    expect(output.leaseId).toBe("42");
    expect(output.state).toBe("active");
    expect(putBody).toMatchObject({ data: { sdl: expect.any(String) } });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${BASE}/v1/deployments/42`,
      expect.objectContaining({ method: "PUT" })
    );
  });

  it("throws HTTP_ERROR with a stable code on non-2xx responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ error: "unauthorized" }, 401)
    );

    const err = await makeAdapter(fetchImpl)
      .balances()
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AkashComputeError);
    expect((err as AkashComputeError).code).toBe("HTTP_ERROR");
    expect((err as AkashComputeError).httpStatus).toBe(401);
  });
});

describe("AkashComputeAdapter bid screening", () => {
  it("leases the audited provider over a cheaper provider failing the quality filter", async () => {
    const h = harness({
      providers: [
        providerEntry("akash1zen"),
        // froggy-class: audited on paper, zero active leases (no proof of registry egress)
        providerEntry("akash1froggy", { leaseCount: 0 }),
      ],
      bids: (dseq) => [
        bidEntry(dseq, "akash1zen", "900"),
        bidEntry(dseq, "akash1froggy", "50"),
      ],
    });

    await makeAdapter(h.fetchImpl).provision({ env: "t", spec: SPEC });
    expect(h.leased).toEqual([{ dseq: "1", provider: "akash1zen" }]);
  });

  it("throws NO_ELIGIBLE_BIDS (and closes) when bids exist but all fail screening", async () => {
    const h = harness({
      providers: [providerEntry("akash1froggy", { isAudited: false })],
      bids: (dseq) => [bidEntry(dseq, "akash1froggy", "50")],
    });

    const err = await makeAdapter(h.fetchImpl)
      .provision({ env: "t", spec: SPEC })
      .catch((e: unknown) => e);

    expect((err as AkashComputeError).code).toBe("NO_ELIGIBLE_BIDS");
    expect((err as AkashComputeError).message).toContain("1");
    expect(h.deletes).toEqual([`${BASE}/v1/deployments/1`]);
  });

  it("excludes a blacklisted provider (3 strikes in outcome history)", async () => {
    const h = harness({
      providers: [providerEntry("akash1struck"), providerEntry("akash1clean")],
      bids: (dseq) => [
        bidEntry(dseq, "akash1struck", "50"),
        bidEntry(dseq, "akash1clean", "900"),
      ],
    });
    const preset = new Map<string, ProviderOutcomeStats>([
      [
        "akash1struck",
        { successes: 0, failures: 3, lastFailureAtMs: Date.now() },
      ],
    ]);

    await makeAdapter(h.fetchImpl, {
      outcomeStore: memStore(preset).store,
    }).provision({ env: "t", spec: SPEC });

    expect(h.leased).toEqual([{ dseq: "1", provider: "akash1clean" }]);
  });

  it("survives a failed provider-metadata read (signedBy stays the hard gate)", async () => {
    const h = harness({
      bids: (dseq) => [bidEntry(dseq, "akash1solo", "100")],
    });
    const base = h.fetchImpl;
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url) === `${BASE}/v1/providers`) {
        return jsonResponse({ error: "boom" }, 500);
      }
      return base(url as never, init);
    });

    await makeAdapter(fetchImpl).provision({ env: "t", spec: SPEC });
    expect(h.leased).toEqual([{ dseq: "1", provider: "akash1solo" }]);
  });
});

describe("AkashComputeAdapter preferredProviders", () => {
  const providers = [
    providerEntry("akash1preferred"),
    providerEntry("akash1stranger"),
    providerEntry("akash1pricier"),
  ];

  it("leases the preferred provider over a cheaper stranger", async () => {
    const h = harness({
      providers,
      bids: (dseq) => [
        bidEntry(dseq, "akash1stranger", "100"),
        bidEntry(dseq, "akash1preferred", "900"),
      ],
    });
    await makeAdapter(h.fetchImpl, {
      bidTimeoutMs: 1000,
      preferredProviders: ["akash1preferred"],
    }).provision({ env: "t", spec: SPEC });
    expect(h.leased.map((l) => l.provider)).toEqual(["akash1preferred"]);
  });

  it("waits past a stranger-only wave and takes the preferred bid on a later poll", async () => {
    const h = harness({
      providers,
      bids: (dseq, wave) =>
        wave === 0
          ? [bidEntry(dseq, "akash1stranger", "100")]
          : [
              bidEntry(dseq, "akash1stranger", "100"),
              bidEntry(dseq, "akash1preferred", "900"),
            ],
    });
    await makeAdapter(h.fetchImpl, {
      bidTimeoutMs: 60_000,
      preferredProviders: ["akash1preferred"],
    }).provision({ env: "t", spec: SPEC });
    expect(h.leased.map((l) => l.provider)).toEqual(["akash1preferred"]);
    expect(h.waves.get("1")).toBeGreaterThanOrEqual(2);
  });

  it("falls back to the best screened stranger when the window closes without a preferred bid", async () => {
    const h = harness({
      providers,
      bids: (dseq) => [
        bidEntry(dseq, "akash1stranger", "100"),
        bidEntry(dseq, "akash1pricier", "500"),
      ],
    });
    await makeAdapter(h.fetchImpl, {
      bidTimeoutMs: 0,
      preferredProviders: ["akash1preferred"],
    }).provision({ env: "t", spec: SPEC });
    expect(h.leased.map((l) => l.provider)).toEqual(["akash1stranger"]);
  });
});

describe("AkashComputeAdapter allowedProviders", () => {
  const allowed = "akash16yr3wxt97ae045a06kr3ycde9srcgpg8syjxxm";
  const stranger = "akash1froggy";

  it("leases only the reachable operator-allowed provider", async () => {
    const h = harness({
      providers: [providerEntry(allowed), providerEntry(stranger)],
      bids: (dseq) => [
        bidEntry(dseq, stranger, "1"),
        bidEntry(dseq, allowed, "900"),
      ],
    });

    await makeAdapter(h.fetchImpl, {
      bidTimeoutMs: 0,
      allowedProviders: [allowed],
    }).provision({ env: "t", spec: SPEC });

    expect(h.leased).toEqual([{ dseq: "1", provider: allowed }]);
  });

  it("fails closed without leasing a fallback when no allowed provider bids", async () => {
    const h = harness({
      providers: [providerEntry(allowed), providerEntry(stranger)],
      bids: (dseq) => [bidEntry(dseq, stranger, "1")],
    });

    await expect(
      makeAdapter(h.fetchImpl, {
        bidTimeoutMs: 0,
        allowedProviders: [allowed],
      }).provision({ env: "t", spec: SPEC })
    ).rejects.toMatchObject({ code: "NO_ELIGIBLE_BIDS" });
    expect(h.leased).toEqual([]);
    expect(h.deletes).toHaveLength(1);
  });
});

describe("AkashComputeAdapter boot SLO", () => {
  const providers = [
    providerEntry("akash1first"),
    providerEntry("akash1second"),
    providerEntry("akash1third"),
  ];
  const threeBids = (dseq: string) => [
    bidEntry(dseq, "akash1first", "100"),
    bidEntry(dseq, "akash1second", "200"),
    bidEntry(dseq, "akash1third", "300"),
  ];

  it.each([
    ["status_unavailable", { statusAvailable: false }, false],
    ["no_endpoint", { endpoints: () => [] }, true],
    ["version_unavailable", { serving: () => false }, true],
    ["source_mismatch", { versionSha: () => "b".repeat(40) }, false],
    ["readiness_unavailable", { ready: () => false }, false],
  ] as const)("classifies a %s boot timeout without leaking probe data", async (stage, probe, providerFailure) => {
    const { records, store } = memStore();
    const h = harness({
      providers: [providerEntry("akash1only")],
      bids: (dseq) => [bidEntry(dseq, "akash1only", "100")],
      ...probe,
    });

    const error = await makeAdapter(h.fetchImpl, {
      bootSloMs: 0,
      outcomeStore: store,
    })
      .provisionWithAllocation(
        {
          env: "t",
          spec: SPEC,
          expectedSourceSha: SOURCE_SHA,
          idempotencyKey: "receipt",
        },
        async () => {}
      )
      .catch((value: unknown) => value);

    expect(error).toMatchObject({
      code: "BOOT_SLO_TIMEOUT",
      bootFailureStage: stage,
    });
    expect(h.deletes).toEqual([`${BASE}/v1/deployments/1`]);
    expect(records.map((record) => record.outcome)).toEqual(
      providerFailure ? ["slo_timeout"] : []
    );
  });

  it("closes the lease, records the strike, and boots on the next screened provider", async () => {
    // dseq 1 (akash1first) never serves; dseq 2 (akash1second) serves immediately.
    const h = harness({
      providers,
      bids: threeBids,
      serving: (host) => host.startsWith("d2."),
    });
    const { records, store } = memStore();

    const out = await makeAdapter(h.fetchImpl, {
      bootSloMs: 0,
      outcomeStore: store,
    }).provision({ env: "t", spec: SPEC });

    expect(h.leased).toEqual([
      { dseq: "1", provider: "akash1first" },
      { dseq: "2", provider: "akash1second" },
    ]);
    expect(h.deletes).toEqual([`${BASE}/v1/deployments/1`]);
    expect(out.leaseId).toBe("2");
    expect(records).toEqual([
      expect.objectContaining({
        providerAccount: "akash1first",
        outcome: "slo_timeout",
        leaseId: "1",
      }),
      expect.objectContaining({
        providerAccount: "akash1second",
        outcome: "boot_ok",
        leaseId: "2",
      }),
    ]);
  });

  it("closes and fails immediately when application readiness is unhealthy", async () => {
    const h = harness({
      providers,
      bids: threeBids,
      serving: () => true,
      ready: (host) => host.startsWith("d2."),
    });
    const { records, store } = memStore();

    const error = await makeAdapter(h.fetchImpl, {
      bootSloMs: 0,
      outcomeStore: store,
    })
      .provision({ env: "t", spec: SPEC })
      .catch((value: unknown) => value);

    expect(h.deletes).toEqual([`${BASE}/v1/deployments/1`]);
    expect(h.leased).toEqual([{ dseq: "1", provider: "akash1first" }]);
    expect(error).toMatchObject({
      code: "BOOT_SLO_TIMEOUT",
      bootFailureStage: "readiness_unavailable",
    });
    expect(records).toEqual([]);
  });

  it("gives up with a terminal BOOT_SLO_TIMEOUT after the provider attempt cap", async () => {
    const h = harness({
      providers,
      bids: threeBids,
      serving: () => false,
    });
    const { records, store } = memStore();

    const err = await makeAdapter(h.fetchImpl, {
      bootSloMs: 0,
      outcomeStore: store,
    })
      .provision({ env: "t", spec: SPEC })
      .catch((e: unknown) => e);

    expect((err as AkashComputeError).code).toBe("BOOT_SLO_TIMEOUT");
    expect((err as AkashComputeError).message).toContain("akash1first");
    expect((err as AkashComputeError).message).toContain("akash1third");
    // every failed deployment was closed (escrow refunds) and every strike recorded
    expect(h.deletes).toEqual([
      `${BASE}/v1/deployments/1`,
      `${BASE}/v1/deployments/2`,
      `${BASE}/v1/deployments/3`,
    ]);
    expect(records.map((r) => [r.providerAccount, r.outcome])).toEqual([
      ["akash1first", "slo_timeout"],
      ["akash1second", "slo_timeout"],
      ["akash1third", "slo_timeout"],
    ]);
  });

  it("keeps polling status through transient read failures inside the SLO window", async () => {
    let statusCalls = 0;
    const h = harness({
      providers: [providerEntry("akash1p")],
      bids: (dseq) => [bidEntry(dseq, "akash1p", "5")],
    });
    const base = h.fetchImpl;
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (/\/v1\/deployments\/\d+$/.test(String(url))) {
        statusCalls++;
        if (statusCalls === 1) return jsonResponse({ error: "boom" }, 500);
      }
      return base(url as never, init);
    });

    const out = await makeAdapter(fetchImpl).provision({
      env: "t",
      spec: SPEC,
    });
    expect(out.state).toBe("active");
    expect(statusCalls).toBeGreaterThanOrEqual(2);
  });
});

describe("AkashComputeAdapter failure containment", () => {
  it("adopts exactly one deployment created beyond a durable allocation cursor", async () => {
    let listWave = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const u = String(url);
      if (u.includes("/v1/deployments?skip=0&limit=1000")) {
        listWave++;
        const dseqs = listWave === 1 ? ["40", "41"] : ["40", "41", "42"];
        return jsonResponse({
          data: {
            deployments: dseqs.map((dseq) => ({
              deployment: { id: { dseq }, state: "active" },
              leases: [],
            })),
            pagination: { hasMore: false },
          },
        });
      }
      if (u === `${BASE}/v1/deployments/42`) {
        return jsonResponse({
          data: {
            deployment: { id: { dseq: "42" }, state: "active" },
            leases: [],
          },
        });
      }
      throw new Error(`unhandled ${u}`);
    });
    const adapter = makeAdapter(fetchImpl);
    const cursor = await adapter.allocationCursor();
    expect(cursor).toBe("41");
    await expect(adapter.findAllocationSince(cursor)).resolves.toMatchObject({
      leaseId: "42",
      state: "pending",
    });
  });

  it("fails closed when more than one deployment exists beyond the allocation cursor", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        data: {
          deployments: ["42", "43"].map((dseq) => ({
            deployment: { id: { dseq }, state: "active" },
            leases: [],
          })),
          pagination: { hasMore: false },
        },
      })
    );
    await expect(
      makeAdapter(fetchImpl).findAllocationSince("41")
    ).rejects.toMatchObject({
      code: "AMBIGUOUS_ADOPTION",
    });
  });

  it("closes the deployment when the create response omits the manifest", async () => {
    const deletes: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      if (u === `${BASE}/v1/providers`) return jsonResponse([]);
      if (u.endsWith("/v1/deployments") && init?.method === "POST") {
        // dseq present (escrow on-chain) but manifest missing → must refund, not strand.
        return jsonResponse({ data: { dseq: "55" } });
      }
      if (init?.method === "DELETE") {
        deletes.push(u);
        return jsonResponse({ data: { success: true } });
      }
      return jsonResponse({ data: [] });
    });

    const err = await makeAdapter(fetchImpl)
      .provision({ env: "t", spec: SPEC })
      .catch((e: unknown) => e);

    expect((err as AkashComputeError).code).toBe("UNEXPECTED_SHAPE");
    expect((err as AkashComputeError).message).toContain("55");
    expect(deletes).toEqual([`${BASE}/v1/deployments/55`]);
  });

  it("never fails a provision because the outcome store is down", async () => {
    const h = harness({
      providers: [providerEntry("akash1p")],
      bids: (dseq) => [bidEntry(dseq, "akash1p", "5")],
    });
    const brokenStore: ProviderOutcomeStore = {
      record: async () => {
        throw new Error("db down");
      },
      stats: async () => {
        throw new Error("db down");
      },
    };

    const out = await makeAdapter(h.fetchImpl, {
      outcomeStore: brokenStore,
    }).provision({ env: "t", spec: SPEC });
    expect(out.state).toBe("active");
  });

  it("never echoes raw response bodies or parsed provider messages in HTTP_ERROR", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          '{"message":"invalid manifest","echo":"AUTH_SECRET=supersecret"}',
          {
            status: 422,
            statusText: "Unprocessable Entity",
          }
        )
    );
    const err = await makeAdapter(fetchImpl)
      .balances()
      .catch((e: unknown) => e);
    const msg = (err as AkashComputeError).message;
    expect(msg).toContain("422");
    expect(msg).not.toContain("invalid manifest");
    expect(msg).not.toContain("supersecret");
  });
});
