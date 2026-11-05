// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/sequencer.test`
 * Purpose: Prove the REAL blue/green state machine over fakes (payer, edge, store, clock): state up,
 *   v1 -> v2 -> v3 blue/green with ordering, failed proof, same-provider refusal, park-after-3,
 *   key hygiene, crash/ambiguity resolution, supersede, and reconcile loss handling (task.5400).
 * Side-effects: none
 */

import { describe, expect, it } from "vitest";
import type { NodeWorkloadSpec } from "@/ports";
import { PayerError } from "@/ports";
import { EdgeRouter } from "./edge";
import {
  DEFAULT_SEQUENCER_CONFIG,
  NodeDeploySequencer,
  type SequencerConfig,
} from "./sequencer";
import {
  canaryApp,
  canaryDb,
  ENV,
  FakeChain,
  FakeClock,
  FakeDns,
  FakePayer,
  FakeProbe,
  MemoryLog,
  MemorySecrets,
  MemoryStore,
  NODE_ID,
  PUBLIC_HOST,
  SHA_1,
  SHA_2,
  SHA_3,
} from "./testing";

const DB = { nodeId: NODE_ID, env: ENV, workload: "canary-db" };
const APP = { nodeId: NODE_ID, env: ENV, workload: "canary" };

function harness(
  cfg: Partial<SequencerConfig> = {},
  opts: { withEdge?: boolean } = {}
) {
  const events: string[] = [];
  const clock = new FakeClock();
  const store = new MemoryStore(clock);
  const payer = new FakePayer(events);
  const dns = new FakeDns(events);
  const probe = new FakeProbe(payer, dns, events);
  const secrets = new MemorySecrets();
  const chain = new FakeChain(payer);
  const log = new MemoryLog();
  const config: SequencerConfig = {
    ...DEFAULT_SEQUENCER_CONFIG,
    namespace: "cogni-production",
    environment: ENV,
    retainMs: 120_000,
    ...cfg,
  };
  const seq = new NodeDeploySequencer({
    store,
    payer,
    edge: opts.withEdge === false ? undefined : new EdgeRouter(dns),
    probe,
    secrets,
    chain,
    clock,
    log,
    config,
  });
  const release = (w: NodeWorkloadSpec, sha: string) =>
    store.recordRelease({
      nodeId: NODE_ID,
      env: ENV,
      workload: w.name,
      sourceSha: sha,
      spec: w,
      createdBy: "test",
    });
  return {
    events,
    clock,
    store,
    payer,
    dns,
    probe,
    secrets,
    chain,
    log,
    seq,
    release,
    config,
  };
}

type H = ReturnType<typeof harness>;

async function stateUp(h: H) {
  await h.release(canaryDb(), SHA_1);
  expect(await h.seq.step(DB)).toBe("driven");
}

async function deployApp(h: H, sha: string) {
  await h.release(canaryApp(), sha);
  return h.seq.step(APP);
}

describe("state workload", () => {
  it("creates the state lease once, proves tls, goes active, mints its password once", async () => {
    const h = harness();
    await stateUp(h);
    const [a] = await h.store.attemptsFor(DB);
    expect(a?.phase).toBe("active");
    expect(a?.endpoints[0]).toMatch(/^tcp:\/\//);
    expect(h.secrets.created).toHaveLength(1);
    const req = h.payer.createRequests[0];
    expect(req?.spec.services[0]?.env?.POSTGRES_PASSWORD).toMatch(/^pw-1/);
    expect(req?.spec.services[0]?.expose).toEqual([
      { port: 5432, as: 5432, global: true },
    ]);
    expect(req?.spec.services[0]?.volumes?.[0]?.mountPath).toBe(
      "/var/lib/postgresql/data"
    );
    // idempotent: another step creates nothing
    expect(await h.seq.step(DB)).toBe("converged");
    expect(h.payer.createRequests).toHaveLength(1);
  });

  it("is NEVER auto-replaced when its lease is lost; reconcile only alerts", async () => {
    const h = harness();
    await stateUp(h);
    h.payer.byDseq("1001").state = "closed";
    expect(await h.seq.reconcile(DB)).toBe("lost_state_alert");
    expect(h.log.alerts()).toContain("state_lease_lost");
    expect(await h.seq.step(DB)).toBe("state_protected");
    expect(h.payer.createRequests).toHaveLength(1);
  });

  it("a state release is not recreated when a later release is recorded over a live lease", async () => {
    const h = harness();
    await stateUp(h);
    await h.release(canaryDb({ memoryMi: 1024 }), SHA_2);
    expect(await h.seq.step(DB)).toBe("state_protected");
    expect(h.payer.liveLeases()).toHaveLength(1);
  });
});

describe("app deploy", () => {
  it("waits (consumes no attempt) until its state workload is active", async () => {
    const h = harness();
    expect(await deployApp(h, SHA_1)).toBe("waiting_dependency");
    expect(h.payer.createRequests).toHaveLength(0);
    expect(await h.store.attemptsFor(APP)).toHaveLength(0);
  });

  it("first deploy: binding + RELEASE_SHA injected, host accepted, edge moved, public readback, active", async () => {
    const h = harness();
    await stateUp(h);
    expect(await deployApp(h, SHA_1)).toBe("driven");
    const req = h.payer.createRequests.at(-1);
    const svc = req?.spec.services[0];
    expect(svc?.env?.RELEASE_SHA).toBe(SHA_1);
    expect(svc?.env?.DATABASE_URL).toMatch(
      /^postgres:\/\/postgres:pw-1-s3cr3t%2Fwith%2Bchars@provider-1\.example:31001\/postgres\?sslmode=require$/
    );
    expect(svc?.expose).toEqual([
      { port: 8080, as: 80, global: true, hosts: [PUBLIC_HOST] },
    ]);
    const [a] = await h.store.attemptsFor(APP);
    expect(a?.phase).toBe("active");
    const rec = [...h.dns.records.values()][0];
    expect(rec).toMatchObject({
      name: PUBLIC_HOST,
      type: "CNAME",
      proxied: true,
      content: "ingress-1002.provider-2.example",
    });
    expect(h.probe.publicReads).toHaveLength(8);
  });

  it("v1 -> v2 -> v3: green proven before the edge moves, blue retained then closed + confirmed", async () => {
    const h = harness();
    await stateUp(h);
    await deployApp(h, SHA_1);
    h.events.length = 0;

    expect(await deployApp(h, SHA_2)).toBe("driven");
    const idxCreate = h.events.indexOf("payer.create:1003");
    const idxMove = h.events.findIndex((e) => e.startsWith("dns."));
    const idxFirstPublic = h.events.indexOf("public.read");
    expect(idxCreate).toBeGreaterThanOrEqual(0);
    expect(idxMove).toBeGreaterThan(idxCreate);
    expect(idxFirstPublic).toBeGreaterThan(idxMove);
    // blue (1002) is still alive: retention window has not elapsed
    expect(h.payer.byDseq("1002").state).toBe("active");
    let attempts = await h.store.attemptsFor(APP);
    expect(attempts.map((a) => a.phase)).toEqual(["active", "retiring"]);
    expect(h.payer.byDseq("1003").provider).not.toBe(
      h.payer.byDseq("1002").provider
    );

    // before retention: step is converged and leaves blue alone
    expect(await h.seq.step(APP)).toBe("converged");
    expect(h.payer.byDseq("1002").state).toBe("active");

    h.clock.advance(h.config.retainMs + 1);
    expect(await h.seq.step(APP)).toBe("converged");
    expect(h.payer.byDseq("1002").state).toBe("closed");
    attempts = await h.store.attemptsFor(APP);
    expect(attempts.map((a) => a.phase)).toEqual(["active", "retired"]);
    expect(h.events.filter((e) => e === "payer.delete:1002")).toHaveLength(1);

    // v3
    expect(await deployApp(h, SHA_3)).toBe("driven");
    h.clock.advance(h.config.retainMs + 1);
    await h.seq.step(APP);
    expect(
      h.payer
        .liveLeases()
        .map((l) => l.dseq)
        .sort()
    ).toEqual(["1001", "1004"]);
    expect([...h.dns.records.values()][0]?.content).toBe(
      "ingress-1004.provider-4.example"
    );
    expect(h.log.steps()).toEqual(
      expect.arrayContaining([
        "edge_moved:ok",
        "public_readback:ok",
        "old_closed:ok",
      ])
    );
  });

  it("a failed proof closes the NEW lease, leaves blue serving and the edge untouched", async () => {
    const h = harness();
    await stateUp(h);
    await deployApp(h, SHA_1);
    const before = [...h.dns.records.values()][0]?.content;
    h.dns.ops.length = 0;
    h.payer.onLease = (l) => {
      l.serveSha = "f".repeat(40); // green serves the WRONG sha
    };
    await deployApp(h, SHA_2);
    const attempts = await h.store.attemptsFor(APP);
    expect(attempts[0]?.phase).toBe("failed");
    expect(attempts[0]?.error).toMatch(/proof_timeout/);
    expect(h.payer.byDseq("1003").state).toBe("closed");
    expect(h.payer.byDseq("1002").state).toBe("active");
    expect(h.dns.ops).toEqual([]);
    expect([...h.dns.records.values()][0]?.content).toBe(before);
    // the proof deadline was 10 minutes from lease creation
    const failedAt = attempts[0]?.updatedAt.getTime() ?? 0;
    const leasedAt = attempts[0]?.leasedAt?.getTime() ?? 0;
    expect(failedAt - leasedAt).toBeGreaterThanOrEqual(h.config.proofMs);
  });

  it("bug.5569: /version 404 for 60s (host not routed) fails host_not_routed fast; green closed, blue and edge untouched; the provider is excluded next", async () => {
    const h = harness();
    await stateUp(h);
    await deployApp(h, SHA_1); // blue: lease 1002 on provider-2
    const before = [...h.dns.records.values()][0]?.content;
    h.dns.ops.length = 0;
    h.payer.onLease = (l) => {
      if (l.provider === "provider-3") l.routeStatus = () => 404;
    };
    await deployApp(h, SHA_2);
    const failed = (await h.store.attemptsFor(APP))[0];
    expect(failed?.phase).toBe("failed");
    expect(failed?.error).toMatch(/^host_not_routed: version 404/);
    expect(failed?.provider).toBe("provider-3");
    const leasedAt = failed?.leasedAt?.getTime() ?? 0;
    const spent = (failed?.updatedAt.getTime() ?? 0) - leasedAt;
    expect(spent).toBeGreaterThanOrEqual(h.config.hostNotRoutedMs);
    expect(spent).toBeLessThan(h.config.proofMs);
    expect(h.payer.byDseq("1003").state).toBe("closed");
    expect(h.payer.byDseq("1002").state).toBe("active");
    expect(h.dns.ops).toEqual([]);
    expect([...h.dns.records.values()][0]?.content).toBe(before);
    expect(
      h.log.lines.some(
        (l) =>
          l.msg === "node_deploy_provider_strike" &&
          l.fields.outcome === "host_not_routed"
      )
    ).toBe(true);
    // the next attempt of the release excludes the unrouted provider (and blue's)
    await h.seq.step(APP);
    const next = h.payer.createRequests.at(-1);
    expect(next?.excludeProviders).toEqual(
      expect.arrayContaining(["provider-2", "provider-3"])
    );
    expect((await h.store.attemptsFor(APP))[0]?.phase).toBe("active");
  });

  it("bug.5569: a 404 run broken by any other answer keeps the full proof window; 503-then-200 still proves", async () => {
    const h = harness();
    await stateUp(h);
    await deployApp(h, SHA_1);
    // 404 for 15 probes (45s), one 503, 404 again for 15, then 503 until ~5 min, then serving.
    h.payer.onLease = (l) => {
      if (l.provider === "provider-3")
        l.routeStatus = (n) =>
          n <= 15 || (n > 16 && n <= 31) ? 404 : n <= 100 ? 503 : undefined;
    };
    await deployApp(h, SHA_2);
    const green = (await h.store.attemptsFor(APP))[0];
    expect(green?.provider).toBe("provider-3");
    expect(green?.phase).toBe("active");
    expect(green?.error ?? "").not.toMatch(/host_not_routed/);
  });

  it("a green lease that lands on blue's provider is a failed proof and is closed", async () => {
    const h = harness();
    await stateUp(h);
    await deployApp(h, SHA_1); // lease 1002 on provider-2
    h.payer.providerFor = () => "provider-2"; // green also lands on provider-2
    h.dns.ops.length = 0;
    await deployApp(h, SHA_2);
    const attempts = await h.store.attemptsFor(APP);
    expect(attempts[0]?.error).toBe("same_provider_as_blue");
    expect(h.payer.byDseq("1003").state).toBe("closed");
    expect(h.payer.byDseq("1002").state).toBe("active");
    expect(h.dns.ops).toEqual([]);
  });

  it("refuses an http app BEFORE paying when no edge is configured", async () => {
    const h = harness({}, { withEdge: false });
    await stateUp(h);
    await deployApp(h, SHA_1);
    expect(h.payer.createRequests).toHaveLength(1); // only the state lease
    const attempts = await h.store.attemptsFor(APP);
    expect(attempts[0]?.error).toBe("edge_not_configured");
  });

  it("cutover failure (public host never serves the sha) restores blue's target and closes green", async () => {
    const h = harness({ publicMs: 20_000 });
    await stateUp(h);
    await deployApp(h, SHA_1);
    const blueTarget = [...h.dns.records.values()][0]?.content;
    // green proves through its ingress but the public edge keeps serving something else
    h.probe.publicStaleReads = 1_000;
    h.probe.stale = "ingress-9999.nowhere.example";
    await deployApp(h, SHA_2);
    const attempts = await h.store.attemptsFor(APP);
    expect(attempts[0]?.phase).toBe("failed");
    expect(attempts[0]?.error).toMatch(/cutover_failed/);
    expect(h.payer.byDseq("1003").state).toBe("closed");
    expect(h.payer.byDseq("1002").state).toBe("active");
    expect([...h.dns.records.values()][0]?.content).toBe(blueTarget);
    expect(h.dns.ops.at(-1)).toContain(blueTarget);
  });

  it("an unchanged streak requirement: one stale read mid-streak resets it", async () => {
    const h = harness();
    await stateUp(h);
    await deployApp(h, SHA_1);
    h.probe.publicReads.length = 0;
    h.probe.publicStaleReads = 3;
    h.probe.stale = "ingress-1002.provider-2.example"; // blue still answers the first 3 reads
    await deployApp(h, SHA_2);
    // 3 stale reads (old sha) then 8 consecutive exact reads
    expect(h.probe.publicReads).toHaveLength(11);
    expect((await h.store.attemptsFor(APP))[0]?.phase).toBe("active");
  });
});

describe("provider exclusion and alert hygiene", () => {
  it("tells the payer to avoid blue's provider and every bound state provider for a create", async () => {
    const h = harness();
    await stateUp(h);
    await deployApp(h, SHA_1);
    const first = h.payer.createRequests.filter(
      (r) => r.spec.name === "canary"
    );
    // first deploy: no blue yet, but the bound state lease (provider-1) is still excluded
    expect(first[0]?.excludeProviders).toEqual(["provider-1"]);
    await deployApp(h, SHA_2);
    const second = h.payer.createRequests.filter(
      (r) => r.spec.name === "canary"
    );
    // blue first, then the state provider, deduped
    expect(second[1]?.excludeProviders).toEqual(["provider-2", "provider-1"]);
  });

  it("HAIRPIN_RULE: an app bound to a state on provider P never sends a create that allows P", async () => {
    const h = harness();
    await stateUp(h);
    const stateProvider = (await h.store.attemptsFor(DB))[0]?.provider;
    expect(stateProvider).toBe("provider-1");
    // every attempt (failed retries, then a later release) excludes the state's provider
    h.payer.onLease = (l) => {
      l.serveSha = "f".repeat(40);
    };
    await h.release(canaryApp(), SHA_1);
    await h.seq.step(APP);
    await h.seq.step(APP);
    h.payer.onLease = undefined;
    await deployApp(h, SHA_2);
    const appCreates = h.payer.createRequests.filter(
      (r) => r.spec.name === "canary"
    );
    expect(appCreates.length).toBeGreaterThanOrEqual(3);
    for (const req of appCreates)
      expect(req.excludeProviders).toContain(stateProvider);
    // a state workload has no bindings: it excludes nothing
    expect(
      h.payer.createRequests.find((r) => r.spec.name === "canary-db")
        ?.excludeProviders
    ).toBeUndefined();
    // the exclusion is logged as a step with the list, and persisted on the attempt
    const logged = h.log.lines.find(
      (l) =>
        l.msg === "node_deploy_step" && l.fields.step === "providers_excluded"
    );
    expect(logged?.fields.providers).toEqual(["provider-1"]);
    const attempts = await h.store.attemptsFor(APP);
    const first = attempts[attempts.length - 1];
    expect(
      first?.steps.find((st) => st.step === "providers_excluded")?.reason
    ).toBe("provider-1");
  });

  it("dedupes exclusions and never exceeds the wire's 16", async () => {
    const h = harness();
    await stateUp(h);
    await deployApp(h, SHA_1);
    // blue sits on the state's provider: one entry, not two
    h.payer.providerFor = () => "provider-1";
    await deployApp(h, SHA_2);
    const req = h.payer.createRequests.filter(
      (r) => r.spec.name === "canary"
    )[1];
    expect(req?.excludeProviders).toEqual(["provider-2", "provider-1"]);
    expect(new Set(req?.excludeProviders).size).toBe(
      req?.excludeProviders?.length
    );
    expect(req?.excludeProviders?.length ?? 0).toBeLessThanOrEqual(16);
  });

  it("bug.5569: a provider that bound a lease and failed proof is excluded from the next attempt of the same release, with blue's provider", async () => {
    const h = harness();
    await stateUp(h); // provider-1
    await deployApp(h, SHA_1); // blue on provider-2
    h.payer.onLease = (l) => {
      l.serveSha = "f".repeat(40); // attempt 1 of SHA_2 binds a lease and fails proof
    };
    await deployApp(h, SHA_2);
    const failed = (await h.store.attemptsFor(APP)).find(
      (a) => a.phase === "failed"
    );
    expect(failed?.provider).toBeTruthy();
    const failedProvider = failed?.provider as string;
    h.payer.onLease = undefined;
    await h.seq.step(APP); // attempt 2 of the same release
    const reqs = h.payer.createRequests.filter((r) => r.spec.name === "canary");
    const second = reqs.at(-1)?.excludeProviders ?? [];
    expect(second).toContain(failedProvider);
    expect(second).toContain("provider-2");
    expect(second).toContain("provider-1");
    // the first attempt of SHA_2 did not exclude the provider it was about to land on
    expect(reqs.at(-2)?.excludeProviders ?? []).not.toContain(failedProvider);
  });

  it("bug.5569: providers of a different release are not excluded", async () => {
    const h = harness();
    await stateUp(h);
    await deployApp(h, SHA_1);
    h.payer.onLease = (l) => {
      l.serveSha = "f".repeat(40);
    };
    await deployApp(h, SHA_2); // SHA_2 attempt fails on some provider P
    const failedProvider = (await h.store.attemptsFor(APP)).find(
      (a) => a.phase === "failed"
    )?.provider as string;
    h.payer.onLease = undefined;
    await h.release(canaryApp(), SHA_3); // a newer release supersedes SHA_2
    await h.seq.step(APP);
    const last = h.payer.createRequests
      .filter((r) => r.spec.name === "canary")
      .at(-1);
    expect(last?.excludeProviders ?? []).not.toContain(failedProvider);
  });

  it("a parked release alerts once per 10 minutes, not once per tick", async () => {
    const h = harness();
    await stateUp(h);
    h.payer.onLease = (l) => {
      l.serveSha = "f".repeat(40);
    };
    await h.release(canaryApp(), SHA_1);
    for (let i = 0; i < 3; i++) await h.seq.step(APP);
    for (let i = 0; i < 50; i++) {
      await h.seq.step(APP);
      h.clock.advance(4_000);
    }
    expect(h.log.alerts().filter((a) => a === "release_parked")).toHaveLength(
      1
    );
    h.clock.advance(11 * 60_000);
    await h.seq.step(APP);
    expect(h.log.alerts().filter((a) => a === "release_parked")).toHaveLength(
      2
    );
  });
});

describe("environment binding (CD4)", () => {
  it("lists and acts only on desired rows of its own env", async () => {
    const h = harness();
    // a row written for ANOTHER environment must never be driven by this sequencer
    await h.store.recordRelease({
      nodeId: NODE_ID,
      env: "preview",
      workload: "canary-db",
      sourceSha: SHA_1,
      spec: canaryDb(),
      createdBy: "test",
    });
    await h.release(canaryDb(), SHA_1);
    expect((await h.store.listDesired(ENV)).map((d) => d.env)).toEqual([ENV]);
    expect((await h.store.listDesired("preview")).map((d) => d.env)).toEqual([
      "preview",
    ]);
    await h.seq.tick();
    await h.seq.reconcileAll();
    // exactly one paid create, for the served env
    expect(h.payer.createRequests).toHaveLength(1);
    expect(h.payer.createRequests[0]?.environment).toBe(ENV);
  });

  it("step/reconcile on a foreign-env key are inert even when called directly", async () => {
    const h = harness();
    await h.store.recordRelease({
      nodeId: NODE_ID,
      env: "preview",
      workload: "canary-db",
      sourceSha: SHA_1,
      spec: canaryDb(),
      createdBy: "test",
    });
    const foreign = { nodeId: NODE_ID, env: "preview", workload: "canary-db" };
    expect(await h.seq.step(foreign)).toBe("idle");
    expect(await h.seq.reconcile(foreign)).toBe("none");
    expect(h.payer.createRequests).toHaveLength(0);
  });
});

describe("orphan lease guard (CD8)", () => {
  it("create succeeded but the response was lost: a SUPERSEDE adopts the lease and closes it, never orphans it", async () => {
    const h = harness();
    await stateUp(h);
    // response lost AND observe down: the attempt cannot be resolved yet
    h.payer.loseResponseOn = (n) => n === 2;
    h.payer.observeThrows = true;
    await deployApp(h, SHA_1);
    let a = (await h.store.attemptsFor(APP))[0];
    expect(a?.phase).toBe("planned");
    expect(a?.externalName).toBeUndefined();
    expect(h.payer.byDseq("1002").state).toBe("active"); // the paid, unbound lease

    // a newer release arrives; observe is STILL down -> the old attempt must NOT be failed/superseded
    await h.release(canaryApp(), SHA_2);
    expect(await h.seq.step(APP)).toBe("superseded");
    a = (await h.store.attemptsFor(APP)).find(
      (x) => x.cogniKey === a?.cogniKey
    );
    expect(a?.phase).toBe("planned");
    expect(h.payer.byDseq("1002").state).toBe("active");
    expect(h.log.steps()).toContain("attempt_failed:deferred");

    // observe recovers: the lease is bound, closed and confirmed, THEN the attempt is failed
    h.payer.observeThrows = false;
    h.payer.loseResponseOn = undefined;
    await h.seq.step(APP);
    const old = (await h.store.attemptsFor(APP)).find(
      (x) => x.cogniKey === a?.cogniKey
    );
    expect(old?.phase).toBe("failed");
    expect(old?.externalName).toBe("1002");
    expect(h.payer.byDseq("1002").state).toBe("closed");
    expect(h.log.steps()).toContain("orphan_lease:adopted_to_close");

    // and the newer release proceeds on a fresh key; no live paid lease is left unowned
    await h.seq.step(APP);
    const live = h.payer.liveLeases().map((l) => l.dseq);
    const owned = (await h.store.attemptsFor(APP))
      .filter((x) => x.phase === "active")
      .map((x) => x.externalName);
    expect(live.filter((d) => d !== "1001").sort()).toEqual(owned.sort());
  });

  it("a failed attempt with a bound handle still closes normally (no extra observe-gate regression)", async () => {
    const h = harness();
    await stateUp(h);
    h.payer.onLease = (l) => {
      l.serveSha = "f".repeat(40);
    };
    await deployApp(h, SHA_1);
    expect((await h.store.attemptsFor(APP))[0]?.phase).toBe("failed");
    expect(h.payer.byDseq("1002").state).toBe("closed");
  });
});

describe("in-flight create grace (observe would settle a still-running create)", () => {
  async function inflight() {
    const h = harness();
    await stateUp(h);
    // the HTTP call died in transit; the actuator is still creating the lease
    h.payer.loseResponseOn = (n) => n === 2;
    h.payer.loseResponseCode = "network";
    const before = h.payer.observeCalls;
    await deployApp(h, SHA_1);
    return { h, before };
  }

  it("a transport-level create failure is unresolved: NOT observed, not failed, not re-created, inside the grace window", async () => {
    const { h, before } = await inflight();
    const a = (await h.store.attemptsFor(APP))[0];
    expect(a?.phase).toBe("planned");
    expect(a?.error).toMatch(/^ambiguous: network@\d+$/);
    expect(h.payer.observeCalls).toBe(before);
    for (let i = 0; i < 5; i++) {
      h.clock.advance(60_000);
      await h.seq.step(APP);
    }
    expect(h.payer.observeCalls).toBe(before); // still no observe (it could settle the in-flight create)
    expect(
      h.payer.createRequests.filter((r) => r.spec.name === "canary")
    ).toHaveLength(1);
    expect((await h.store.attemptsFor(APP))[0]?.phase).toBe("planned");
    expect(h.log.steps()).toContain("create:inflight_grace");
  });

  it("a SUPERSEDE inside the grace window is deferred (never fails or supersedes while the create may be running)", async () => {
    const { h, before } = await inflight();
    await h.release(canaryApp(), SHA_2);
    expect(await h.seq.step(APP)).toBe("superseded");
    const old = (await h.store.attemptsFor(APP)).find(
      (x) => x.phase === "planned"
    );
    expect(old?.phase).toBe("planned");
    expect(h.payer.observeCalls).toBe(before);
    expect(h.payer.byDseq("1002").state).toBe("active"); // the unbound lease is still safe, not orphaned
  });

  it("after the grace window the attempt is resolved through observe and the lease adopted", async () => {
    const { h } = await inflight();
    h.clock.advance(h.config.inflightGraceMs + 1_000);
    await h.seq.step(APP);
    const a = (await h.store.attemptsFor(APP))[0];
    expect(a?.externalName).toBe("1002");
    expect(a?.phase).toBe("active");
    expect(
      h.payer.createRequests.filter((r) => r.spec.name === "canary")
    ).toHaveLength(1);
  });

  it("a superseded in-flight attempt is adopted and CLOSED once the grace window ends", async () => {
    const { h } = await inflight();
    await h.release(canaryApp(), SHA_2);
    await h.seq.step(APP);
    h.clock.advance(h.config.inflightGraceMs + 1_000);
    await h.seq.step(APP);
    expect(h.payer.byDseq("1002").state).toBe("closed");
    expect(h.log.steps()).toContain("orphan_lease:adopted_to_close");
  });
});

describe("in-flight grace anchoring and log throttle (follow-up)", () => {
  it("the grace window starts at the NETWORK FAILURE, not at the attempt's creation", async () => {
    const h = harness();
    await stateUp(h);
    // attempt row is created, then waits on a busy wallet for 200 s BEFORE the transport failure
    h.payer.createFault = (n) =>
      n === 2
        ? new PayerError("wallet_allocation_blocked", "busy", false)
        : undefined;
    h.payer.loseResponseOn = (n) => n === 3;
    h.payer.loseResponseCode = "network";
    await deployApp(h, SHA_1);
    const created =
      (await h.store.attemptsFor(APP))[0]?.createdAt.getTime() ?? 0;
    h.clock.advance(200_000);
    await h.seq.step(APP); // the create now goes out and dies in transit
    const a = (await h.store.attemptsFor(APP))[0];
    expect(a?.error).toBe(`ambiguous: network@${h.clock.now()}`);
    const failedAt = h.clock.now();
    expect(failedAt - created).toBe(200_000);

    // createdAt + grace has passed, failure + grace has NOT: still unresolved, still not observed
    const before = h.payer.observeCalls;
    h.clock.t = created + h.config.inflightGraceMs + 60_000;
    await h.seq.step(APP);
    expect(h.payer.observeCalls).toBe(before);
    expect((await h.store.attemptsFor(APP))[0]?.phase).toBe("planned");

    // after failure + grace: resolved through observe, lease adopted
    h.clock.t = failedAt + h.config.inflightGraceMs + 1_000;
    await h.seq.step(APP);
    const done = (await h.store.attemptsFor(APP))[0];
    expect(done?.externalName).toBe("1003");
    expect(done?.phase).toBe("active");
  });

  it("a legacy marker without a stamp falls back to the attempt's creation time", async () => {
    const h = harness();
    await stateUp(h);
    h.payer.loseResponseOn = (n) => n === 2;
    h.payer.loseResponseCode = "network";
    await deployApp(h, SHA_1);
    const a = (await h.store.attemptsFor(APP))[0];
    if (!a) throw new Error("no attempt");
    await h.store.updateAttempt(a.id, { error: "ambiguous: network" }); // pre-follow-up row
    const before = h.payer.observeCalls;
    await h.seq.step(APP);
    expect(h.payer.observeCalls).toBe(before); // still inside createdAt + grace
    h.clock.advance(h.config.inflightGraceMs + 1_000);
    await h.seq.step(APP);
    expect((await h.store.attemptsFor(APP))[0]?.phase).toBe("active");
  });

  it("inflight_grace is logged once per 60 s per attempt, not once per tick", async () => {
    const h = harness();
    await stateUp(h);
    h.payer.loseResponseOn = (n) => n === 2;
    h.payer.loseResponseCode = "network";
    await deployApp(h, SHA_1);
    const graceLines = () =>
      h.log.steps().filter((x) => x === "create:inflight_grace").length;
    expect(graceLines()).toBe(1);
    // 5 ticks inside the same minute add nothing
    for (let i = 0; i < 5; i++) {
      h.clock.advance(5_000);
      await h.seq.step(APP);
    }
    expect(graceLines()).toBe(1);
    // five minutes of 5 s ticks (60 ticks): about one line per minute, never one per tick
    for (let i = 0; i < 55; i++) {
      h.clock.advance(5_000);
      await h.seq.step(APP);
    }
    expect(graceLines()).toBeGreaterThanOrEqual(5);
    expect(graceLines()).toBeLessThanOrEqual(6);
  });
});

describe("game day (operator-requested kill; recovery is the ordinary reconcile path)", () => {
  async function live() {
    const h = harness();
    await stateUp(h);
    await deployApp(h, SHA_1); // app lease 1002 active
    return h;
  }
  const desiredOf = async (h: H, key = APP) => h.store.getDesired(key);

  it("kills the ACTIVE lease through the payer, leaves desired + release untouched, logs the kill, clears the intent", async () => {
    const h = await live();
    const before = await desiredOf(h);
    await h.store.requestGameDay(APP);
    h.events.length = 0;
    await h.seq.step(APP);
    expect(h.events).toContain("payer.delete:1002");
    expect(h.payer.byDseq("1002").state).toBe("closed");
    const kill = h.log.lines.find((l) => l.msg === "node_deploy_game_day_kill");
    expect(kill?.fields).toMatchObject({
      dseq: "1002",
      workload: "canary",
      step: "game_day_kill",
      sourceSha: SHA_1,
    });
    const after = await desiredOf(h);
    expect(after?.gameDayRequestedAt).toBeUndefined(); // intent consumed
    expect(after?.releaseId).toBe(before?.releaseId); // release untouched
    expect(after?.state).toBe("running"); // desired state untouched
    // the attempt is NOT marked by the kill: loss is the reconcile path's to find
    expect((await h.store.attemptsFor(APP))[0]?.phase).toBe("active");
  });

  it("then the NORMAL reconcile detects the close and recovers the SAME release (no special-casing)", async () => {
    const h = await live();
    const releaseId = (await h.store.attemptsFor(APP))[0]?.releaseId;
    await h.store.requestGameDay(APP);
    await h.seq.step(APP); // the kill
    expect(await h.seq.reconcile(APP)).toBe("lost_app");
    expect(await h.seq.step(APP)).toBe("driven");
    const [newest, lost] = await h.store.attemptsFor(APP);
    expect(lost?.phase).toBe("lost");
    expect(newest?.phase).toBe("active");
    expect(newest?.releaseId).toBe(releaseId);
    expect(
      h.payer.createRequests.at(-1)?.spec.services[0]?.env?.RELEASE_SHA
    ).toBe(SHA_1);
    expect(
      h.payer
        .liveLeases()
        .map((l) => l.dseq)
        .sort()
    ).toEqual(["1001", newest?.externalName].sort());
    // exactly one kill happened, and recovery did not re-trigger it
    expect(
      h.log.lines.filter((l) => l.msg === "node_deploy_game_day_kill")
    ).toHaveLength(1);
  });

  it("refuses a state workload: nothing is deleted and the intent is dropped with an alert", async () => {
    const h = await live();
    await h.store.requestGameDay(DB);
    h.events.length = 0;
    await h.seq.step(DB);
    expect(h.events.filter((e) => e.startsWith("payer.delete"))).toEqual([]);
    expect(h.payer.byDseq("1001").state).toBe("active");
    expect(h.log.alerts()).toContain("game_day_refused_state");
    expect((await desiredOf(h, DB))?.gameDayRequestedAt).toBeUndefined();
  });

  it("waits while another attempt is in flight (a cutover may be moving the edge); the intent stays durable", async () => {
    const h = await live();
    h.payer.createFault = (n) =>
      n === 3
        ? new PayerError("wallet_allocation_blocked", "busy", false)
        : undefined;
    await deployApp(h, SHA_2); // v2 stuck in `planned`
    expect((await h.store.attemptsFor(APP))[0]?.phase).toBe("planned");
    await h.store.requestGameDay(APP);
    h.events.length = 0;
    await h.seq.step(APP);
    expect(h.events.filter((e) => e.startsWith("payer.delete"))).toEqual([]);
    expect((await desiredOf(h))?.gameDayRequestedAt).toBeDefined();
  });

  it("a failed delete keeps the intent and retries on the next tick", async () => {
    const h = await live();
    await h.store.requestGameDay(APP);
    h.payer.failDelete = true;
    await h.seq.step(APP);
    expect((await desiredOf(h))?.gameDayRequestedAt).toBeDefined();
    expect(h.log.steps()).toContain("game_day_kill:delete_failed");
    expect(
      h.log.lines.filter((l) => l.msg === "node_deploy_game_day_kill")
    ).toHaveLength(0);
    h.payer.failDelete = false;
    await h.seq.step(APP);
    expect(h.payer.byDseq("1002").state).toBe("closed");
    expect((await desiredOf(h))?.gameDayRequestedAt).toBeUndefined();
  });

  it("no active lease: the intent is cleared as a no-op and nothing is deleted", async () => {
    const h = harness();
    await h.release(canaryApp(), SHA_1);
    await h.store.requestGameDay(APP);
    await h.seq.step(APP);
    expect(h.payer.liveLeases()).toEqual([]);
    expect(h.log.steps()).toContain("game_day_kill:no_active_lease");
    expect((await desiredOf(h))?.gameDayRequestedAt).toBeUndefined();
  });
});

describe("edge host guard before any paid create (task.5400 review)", () => {
  it("a declared host the edge guard refuses never reaches the payer; three refusals park the release", async () => {
    const h = harness();
    await stateUp(h);
    const bad = canaryApp({
      expose: { http: { host: "poly.cognidao.org" } },
    } as never);
    await h.release(bad, SHA_1);
    const outcomes: string[] = [];
    for (let i = 0; i < 4; i++) outcomes.push(await h.seq.step(APP));
    expect(outcomes).toEqual(["driven", "driven", "driven", "parked"]);
    expect(
      h.payer.createRequests.filter((r) => r.spec.name === "canary")
    ).toHaveLength(0);
    const attempts = await h.store.attemptsFor(APP);
    expect(attempts).toHaveLength(3);
    expect(
      attempts.every((a) => a.error?.startsWith("edge_host_refused"))
    ).toBe(true);
    expect(h.log.alerts()).toContain("release_parked");
    expect(h.dns.ops).toEqual([]);
  });
});

describe("observability hygiene (review)", () => {
  it("a same-provider refusal writes a provider_strike event naming the provider (no exclusion exists on the actuator wire)", async () => {
    const h = harness();
    await stateUp(h);
    await deployApp(h, SHA_1);
    h.payer.providerFor = () => "provider-2";
    await deployApp(h, SHA_2);
    const strikes = h.log.lines.filter(
      (l) => l.msg === "node_deploy_provider_strike"
    );
    expect(strikes).toHaveLength(1);
    expect(strikes[0]?.fields).toMatchObject({
      step: "provider_strike",
      outcome: "same_provider_as_blue",
      provider: "provider-2",
      workload: "canary",
      sourceSha: SHA_2,
    });
  });

  it("a proof timeout is also a strike", async () => {
    const h = harness();
    await stateUp(h);
    h.payer.onLease = (l) => {
      l.serveSha = "f".repeat(40);
    };
    await deployApp(h, SHA_1);
    expect(
      h.log.lines.filter((l) => l.msg === "node_deploy_provider_strike")[0]
        ?.fields.outcome
    ).toBe("proof_timeout");
  });

  it("a tick-level failure that repeats every tick is logged once per 10 minutes", async () => {
    const h = harness();
    await h.release(canaryDb(), SHA_1);
    h.store.getDesired = async () => {
      throw new Error("database is down");
    };
    for (let i = 0; i < 20; i++) {
      await h.seq.tick();
      h.clock.advance(5_000);
    }
    const threw = () =>
      h.log.lines.filter(
        (l) => l.msg === "node_deploy_step" && l.fields.outcome === "threw"
      );
    expect(threw()).toHaveLength(1);
    h.clock.advance(11 * 60_000);
    await h.seq.tick();
    expect(threw()).toHaveLength(2);
  });
});

describe("keys and parking", () => {
  it("every create uses a fresh url-safe key; identity states the tuple", async () => {
    const h = harness();
    await stateUp(h);
    h.payer.onLease = (l) => {
      l.serveSha = "f".repeat(40);
    };
    await deployApp(h, SHA_1);
    await h.seq.step(APP);
    const keys = h.payer.createRequests.map((r) => r.cogniKey);
    expect(new Set(keys).size).toBe(keys.length);
    const appReqs = h.payer.createRequests.filter(
      (r) => r.spec.name === "canary"
    );
    expect(appReqs.map((r) => r.identity.compositeGeneration)).toEqual([1, 2]);
    for (const r of appReqs) {
      expect(r.cogniKey).toMatch(
        new RegExp(
          `^nd:cogni-production:${NODE_ID}:canary:[0-9a-f-]{36}:[0-9]+$`
        )
      );
      expect(r.cogniKey).toMatch(/^[A-Za-z0-9._:/-]+$/);
      expect(r.identity).toEqual({
        nodeId: NODE_ID,
        compositeUid: `nd-${r.cogniKey.split(":")[4]}`,
        compositeGeneration: Number(r.cogniKey.split(":")[5]),
      });
    }
  });

  it("parks after 3 consecutive failed attempts and never pays a 4th time, however much time passes", async () => {
    const h = harness();
    await stateUp(h);
    h.payer.onLease = (l) => {
      l.serveSha = "f".repeat(40);
    };
    await h.release(canaryApp(), SHA_1);
    const outcomes: string[] = [];
    for (let i = 0; i < 6; i++) {
      outcomes.push(await h.seq.step(APP));
      h.clock.advance(24 * 3_600_000);
    }
    expect(outcomes).toEqual([
      "driven",
      "driven",
      "driven",
      "parked",
      "parked",
      "parked",
    ]);
    const appCreates = h.payer.createRequests.filter(
      (r) => r.spec.name === "canary"
    );
    expect(appCreates).toHaveLength(3);
    expect(h.log.alerts()).toContain("release_parked");
    expect(h.payer.liveLeases().map((l) => l.dseq)).toEqual(["1001"]);
    // a NEW release un-parks (a different release, its own attempt count)
    h.payer.onLease = undefined;
    await h.release(canaryApp(), SHA_2);
    expect(await h.seq.step(APP)).toBe("driven");
    expect((await h.store.attemptsFor(APP))[0]?.phase).toBe("active");
  });
});

describe("crash safety", () => {
  it("persists the attempt row BEFORE the paid create", async () => {
    const h = harness();
    await stateUp(h);
    let rowsAtCreate = -1;
    h.payer.createFault = (_n, req) => {
      if (req.spec.name === "canary") {
        rowsAtCreate = h.store.attempts.filter(
          (a) => a.releaseId && a.cogniKey === req.cogniKey
        ).length;
        return new PayerError("provider_rejected", "boom", false);
      }
      return undefined;
    };
    await deployApp(h, SHA_1);
    expect(rowsAtCreate).toBe(1);
  });

  it("a lost create response is resolved through observe(cogniKey), not re-created", async () => {
    const h = harness();
    await stateUp(h);
    h.payer.loseResponseOn = (n) => n === 2;
    await deployApp(h, SHA_1);
    const appCreates = h.payer.createRequests.filter(
      (r) => r.spec.name === "canary"
    );
    expect(appCreates).toHaveLength(1);
    expect(
      h.payer.leases.filter((l) => l.cogniKey === appCreates[0]?.cogniKey)
    ).toHaveLength(1);
    expect((await h.store.attemptsFor(APP))[0]?.phase).toBe("active");
  });

  it("an ambiguous create whose observe also fails stays planned, then adopts on the next tick", async () => {
    const h = harness();
    await stateUp(h);
    h.payer.loseResponseOn = (n) => n === 2;
    h.payer.observeThrows = true;
    await deployApp(h, SHA_1);
    let a = (await h.store.attemptsFor(APP))[0];
    expect(a?.phase).toBe("planned");
    expect(a?.error).toMatch(/^ambiguous/);
    h.payer.observeThrows = false;
    await h.seq.step(APP);
    a = (await h.store.attemptsFor(APP))[0];
    expect(a?.phase).toBe("active");
    expect(
      h.payer.createRequests.filter((r) => r.spec.name === "canary")
    ).toHaveLength(1);
  });

  it("an ambiguous create that observes as nothing fails the attempt and uses a NEW key next", async () => {
    const h = harness();
    await stateUp(h);
    h.payer.createFault = (n) =>
      n === 2 ? new PayerError("outcome_unknown", "lost", true) : undefined;
    await deployApp(h, SHA_1);
    expect((await h.store.attemptsFor(APP))[0]?.phase).toBe("failed");
    await h.seq.step(APP);
    const keys = h.payer.createRequests
      .filter((r) => r.spec.name === "canary")
      .map((r) => r.cogniKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect((await h.store.attemptsFor(APP))[0]?.phase).toBe("active");
  });

  it("a refused create (provider_rejected) is never replayed under the same key, even when observe is down (bug.5567)", async () => {
    const h = harness();
    await stateUp(h);
    h.payer.createFault = (n) =>
      n === 2
        ? new PayerError("provider_rejected", "bid refused", false)
        : undefined;
    h.payer.observeThrows = true;
    await deployApp(h, SHA_1);
    const first = (await h.store.attemptsFor(APP))[0];
    expect(first?.phase).toBe("planned"); // failAttempt deferred: observe is down
    expect(first?.error).toMatch(/^create refused: provider_rejected/);
    await h.seq.step(APP);
    await h.seq.step(APP);
    // re-driven twice: the refused key was NOT created again
    expect(
      h.payer.createRequests.filter((r) => r.cogniKey === first?.cogniKey)
    ).toHaveLength(1);

    // observe recovers: attempt 1 fails, attempt 2 uses a NEW key and serves
    h.payer.observeThrows = false;
    h.payer.createFault = undefined;
    await h.seq.step(APP);
    const rows = await h.store.attemptsFor(APP);
    expect(rows.find((a) => a.attempt === 1)?.phase).toBe("failed");
    await h.seq.step(APP);
    const active = (await h.store.attemptsFor(APP)).find(
      (a) => a.phase === "active"
    );
    expect(active?.attempt).toBe(2);
    expect(active?.cogniKey).not.toBe(first?.cogniKey);
    expect(
      h.payer.createRequests.filter((r) => r.cogniKey === first?.cogniKey)
    ).toHaveLength(1);
  });

  it("bug.5569 (a): a definitive pre-deployment refusal runs the ONE cleanup chain in the same tick (observe, nothing found, failed); no grace; the next attempt proceeds", async () => {
    const h = harness();
    await stateUp(h);
    h.payer.createFault = (n) =>
      n === 2
        ? new PayerError(
            "provider_rejected",
            "actuator /v1/akash/create -> HTTP 422 provider_rejected: Console request failed with HTTP 422",
            false,
            true
          )
        : undefined;
    const observesBefore = h.payer.observeCalls;
    await deployApp(h, SHA_1);
    const first = (await h.store.attemptsFor(APP))[0];
    expect(first?.phase).toBe("failed");
    expect(first?.error).toMatch(/^create refused: provider_rejected/);
    expect(first?.externalName ?? null).toBeNull();
    // the chain observed by key, in this tick (that observe settles the actuator receipt)
    expect(h.payer.observeCalls).toBe(observesBefore + 1);
    expect(h.log.steps()).toContain("attempt_failed:failed");
    expect(h.log.steps()).not.toContain("attempt_failed:deferred");
    expect(h.log.steps()).not.toContain("create:inflight_grace");
    // the very next tick takes a NEW key and serves
    await h.seq.step(APP);
    const active = (await h.store.attemptsFor(APP)).find(
      (a) => a.phase === "active"
    );
    expect(active?.attempt).toBe(2);
    expect(
      h.payer.createRequests.filter((r) => r.cogniKey === first?.cogniKey)
    ).toHaveLength(1);
  });

  it("bug.5569 (b): a definitive refusal whose rolled-back deployment is still under the key is bound, closed and confirmed in the same tick; no grace; the next attempt proceeds", async () => {
    const h = harness();
    await stateUp(h);
    h.payer.createFault = (n, req) => {
      if (n !== 2) return undefined;
      // the actuator opened deployment 9009, found no eligible bid, closed it and read it back closed
      h.payer.leases.push({
        dseq: "9009",
        cogniKey: req.cogniKey,
        provider: "",
        state: "closed",
        endpoints: [],
        env: {},
      });
      return new PayerError(
        "provider_rejected",
        "none passed provider screening (deployment 9009 closed, escrow refunding)",
        false,
        true
      );
    };
    await deployApp(h, SHA_1);
    const first = (await h.store.attemptsFor(APP))[0];
    expect(first?.phase).toBe("failed");
    expect(first?.externalName).toBe("9009");
    expect(first?.error).toMatch(/^create refused: provider_rejected/);
    expect(h.log.steps()).toContain("orphan_lease:adopted_to_close");
    expect(h.log.steps()).toContain("new_closed:ok");
    expect(h.events).toContain("payer.delete:9009");
    expect(h.log.steps()).not.toContain("create:inflight_grace");
    expect(h.log.alerts()).not.toContain("close_unconfirmed");
    await h.seq.step(APP);
    const active = (await h.store.attemptsFor(APP)).find(
      (a) => a.phase === "active"
    );
    expect(active?.attempt).toBe(2);
  });

  it("observe unavailable is bounded: past 15 min the attempt fails orphan_suspect with an alert and the release moves on", async () => {
    const h = harness();
    await stateUp(h);
    h.payer.loseResponseOn = (n) => n === 2;
    h.payer.observeThrows = true;
    await deployApp(h, SHA_1);
    const first = (await h.store.attemptsFor(APP))[0];
    expect(first?.phase).toBe("planned");
    h.clock.advance(14 * 60_000);
    await h.seq.step(APP);
    expect((await h.store.attemptsFor(APP))[0]?.phase).toBe("planned");
    expect(h.log.alerts()).not.toContain("orphan_suspect");
    h.clock.advance(61_000);
    await h.seq.step(APP);
    const failed = (await h.store.attemptsFor(APP)).find(
      (a) => a.attempt === 1
    );
    expect(failed?.phase).toBe("failed");
    expect(failed?.error).toMatch(/^orphan_suspect:/);
    expect(h.log.alerts()).toContain("orphan_suspect");
    // the paid lease is NOT claimed closed
    expect(h.payer.byDseq("1002").state).toBe("active");
    // later releases are unblocked: the next attempt takes a new ordinal
    h.payer.observeThrows = false;
    h.payer.loseResponseOn = undefined;
    await h.seq.step(APP);
    expect((await h.store.attemptsFor(APP)).some((a) => a.attempt === 2)).toBe(
      true
    );
  });

  it("supersede with observe down is bounded the same way", async () => {
    const h = harness();
    await stateUp(h);
    h.payer.createFault = (n) =>
      n === 2
        ? new PayerError("wallet_allocation_blocked", "busy", false)
        : undefined;
    await deployApp(h, SHA_1);
    h.payer.observeThrows = true;
    await h.release(canaryApp(), SHA_2);
    expect(await h.seq.step(APP)).toBe("superseded");
    expect((await h.store.attemptsFor(APP))[0]?.phase).toBe("planned");
    h.clock.advance(16 * 60_000);
    await h.seq.step(APP);
    const old = (await h.store.attemptsFor(APP)).find((a) => a.attempt === 1);
    expect(old?.phase).toBe("failed");
    expect(old?.error).toMatch(/^orphan_suspect:/);
    expect(h.log.alerts()).toContain("orphan_suspect");
  });

  it("a newer release supersedes an attempt not yet at the edge", async () => {
    const h = harness();
    await stateUp(h);
    // attempt 1 stalls in planned (wallet busy)
    h.payer.createFault = (n) =>
      n === 2
        ? new PayerError("wallet_allocation_blocked", "busy", false)
        : undefined;
    await deployApp(h, SHA_1);
    expect((await h.store.attemptsFor(APP))[0]?.phase).toBe("planned");
    await h.release(canaryApp(), SHA_2);
    expect(await h.seq.step(APP)).toBe("superseded");
    expect((await h.store.attemptsFor(APP))[0]?.phase).toBe("failed");
    h.payer.createFault = undefined;
    expect(await h.seq.step(APP)).toBe("driven");
    expect((await h.store.attemptsFor(APP))[0]?.phase).toBe("active");
  });

  it("a close that cannot be confirmed blocks any further paid create", async () => {
    const h = harness({ closeConfirmMs: 5_000 });
    await stateUp(h);
    h.payer.onLease = (l) => {
      l.serveSha = "f".repeat(40);
    };
    h.payer.failDelete = true;
    await deployApp(h, SHA_1);
    expect((await h.store.attemptsFor(APP))[0]?.phase).toBe("closing");
    expect(h.log.alerts()).toContain("close_unconfirmed");
    expect(await h.seq.step(APP)).toBe("close_pending");
    expect(
      h.payer.createRequests.filter((r) => r.spec.name === "canary")
    ).toHaveLength(1);
    h.payer.failDelete = false;
    expect(await h.seq.step(APP)).toBe("driven"); // janitor confirmed, a fresh attempt follows
  });

  it("a stopped workload is left alone by both loops", async () => {
    const h = harness();
    await h.release(canaryDb(), SHA_1);
    h.store.setDesiredState(DB, "stopped");
    expect(await h.seq.step(DB)).toBe("idle");
    expect(await h.seq.reconcile(DB)).toBe("none");
    expect(h.payer.createRequests).toHaveLength(0);
  });
});

describe("reconcile", () => {
  async function liveApp() {
    const h = harness();
    await stateUp(h);
    await deployApp(h, SHA_1);
    return h;
  }

  it("a healthy lease is left alone", async () => {
    const h = await liveApp();
    expect(await h.seq.reconcile(APP)).toBe("healthy");
    expect(h.payer.createRequests).toHaveLength(2);
  });

  it("a lease closed on chain is lost: the next step is a new attempt of the SAME release at the same sha", async () => {
    const h = await liveApp();
    const releaseId = (await h.store.attemptsFor(APP))[0]?.releaseId;
    h.payer.byDseq("1002").state = "closed";
    expect(await h.seq.reconcile(APP)).toBe("lost_app");
    expect(await h.seq.step(APP)).toBe("driven");
    const [newest, lost] = await h.store.attemptsFor(APP);
    expect(lost?.phase).toBe("lost");
    expect(newest?.phase).toBe("active");
    expect(newest?.releaseId).toBe(releaseId);
    expect(newest?.attempt).toBe(2);
    expect(
      h.payer.createRequests.at(-1)?.spec.services[0]?.env?.RELEASE_SHA
    ).toBe(SHA_1);
    expect(h.payer.createRequests.at(-1)?.cogniKey).not.toBe(lost?.cogniKey);
    // the edge was never withdrawn: it was re-pointed at the new lease
    expect([...h.dns.records.values()]).toHaveLength(1);
  });

  it("insufficient_funds on chain is a loss even when the actuator still says active", async () => {
    const h = await liveApp();
    h.chain.override.set("1002", "insufficient_funds");
    expect(await h.seq.reconcile(APP)).toBe("lost_app");
  });

  it("an observe blip is NOT a loss", async () => {
    const h = await liveApp();
    h.payer.observeThrows = true;
    expect(await h.seq.reconcile(APP)).toBe("healthy");
    expect((await h.store.attemptsFor(APP))[0]?.phase).toBe("active");
  });

  it("a live lease failing its proof is only an alert until 15 consecutive minutes, then closed + replaced", async () => {
    const h = await liveApp();
    h.payer.byDseq("1002").down = true;
    expect(await h.seq.reconcile(APP)).toBe("unhealthy_waiting");
    expect(h.log.alerts()).toContain("proof_failing");
    h.clock.advance(14 * 60_000);
    expect(await h.seq.reconcile(APP)).toBe("unhealthy_waiting");
    expect(h.payer.byDseq("1002").state).toBe("active");
    h.clock.advance(61_000);
    expect(await h.seq.reconcile(APP)).toBe("lost_app");
    expect(h.payer.byDseq("1002").state).toBe("closed"); // closed + confirmed first
    expect(await h.seq.step(APP)).toBe("driven");
    expect((await h.store.attemptsFor(APP))[0]?.phase).toBe("active");
  });

  it("a serving lease whose /readyz fails (dependency down) is kept after 15 min: alert, no close, no redeploy", async () => {
    const h = await liveApp();
    h.payer.byDseq("1002").notReady = true; // /version still answers the exact sha
    expect(await h.seq.reconcile(APP)).toBe("unhealthy_waiting");
    h.clock.advance(16 * 60_000);
    expect(await h.seq.reconcile(APP)).toBe("unhealthy_waiting");
    expect(h.log.alerts()).toContain("dependency_down");
    expect(h.payer.byDseq("1002").state).toBe("active");
    expect(h.events).not.toContain("payer.delete:1002");
    expect((await h.store.attemptsFor(APP))[0]?.phase).toBe("active");
    expect(await h.seq.step(APP)).toBe("converged");
    expect(h.payer.createRequests).toHaveLength(2);
    // /version fails too: the 15 min for a BAD lease start now; one blip never closes the lease
    h.payer.byDseq("1002").down = true;
    expect(await h.seq.reconcile(APP)).toBe("unhealthy_waiting");
    expect(h.payer.byDseq("1002").state).toBe("active");
    expect(h.events).not.toContain("payer.delete:1002");
    h.clock.advance(14 * 60_000);
    expect(await h.seq.reconcile(APP)).toBe("unhealthy_waiting");
    expect(h.payer.byDseq("1002").state).toBe("active");
    h.clock.advance(61_000);
    expect(await h.seq.reconcile(APP)).toBe("lost_app");
    expect(h.payer.byDseq("1002").state).toBe("closed");
  });

  it("recovering after a dependency outage clears its marker", async () => {
    const h = await liveApp();
    h.payer.byDseq("1002").notReady = true;
    await h.seq.reconcile(APP);
    await h.seq.reconcile(APP);
    expect((await h.store.attemptsFor(APP))[0]?.error).toBe("dependency_down");
    h.payer.byDseq("1002").notReady = false;
    expect(await h.seq.reconcile(APP)).toBe("healthy");
    const a = (await h.store.attemptsFor(APP))[0];
    expect(a?.error).toBeUndefined();
    expect(a?.unhealthySince).toBeUndefined();
  });

  it("a thrown non-PayerError from create is not replayed under the same key", async () => {
    const h = harness();
    await stateUp(h);
    h.payer.createFault = (n) => {
      if (n === 2) throw new Error("boom");
      return undefined;
    };
    h.payer.observeThrows = true;
    await deployApp(h, SHA_1);
    await h.seq.step(APP);
    const key = (await h.store.attemptsFor(APP))[0]?.cogniKey;
    expect(
      h.payer.createRequests.filter((r) => r.cogniKey === key)
    ).toHaveLength(1);
  });

  it("recovering inside the window clears the unhealthy clock", async () => {
    const h = await liveApp();
    h.payer.byDseq("1002").down = true;
    await h.seq.reconcile(APP);
    h.clock.advance(10 * 60_000);
    h.payer.byDseq("1002").down = false;
    expect(await h.seq.reconcile(APP)).toBe("healthy");
    expect((await h.store.attemptsFor(APP))[0]?.unhealthySince).toBeUndefined();
    h.payer.byDseq("1002").down = true;
    await h.seq.reconcile(APP);
    h.clock.advance(10 * 60_000);
    expect(await h.seq.reconcile(APP)).toBe("unhealthy_waiting");
  });

  it("step and reconcile never overlap for one workload", async () => {
    const h = await liveApp();
    const slow = h.seq.step(APP);
    const second = await h.seq.reconcile(APP);
    await slow;
    expect(["busy", "healthy", "none"]).toContain(second);
  });
});

describe("logging", () => {
  it("every step carries the observability fields Loki is queried by", async () => {
    const h = harness();
    await stateUp(h);
    await deployApp(h, SHA_1);
    const line = h.log.lines.find(
      (l) =>
        l.msg === "node_deploy_step" &&
        l.fields.step === "activated" &&
        l.fields.workload === "canary"
    );
    expect(line?.fields).toMatchObject({
      component: "node-deploy-sequencer",
      nodeId: NODE_ID,
      env: ENV,
      workload: "canary",
      attempt: 1,
      dseq: "1002",
      step: "activated",
      outcome: "ok",
      sourceSha: SHA_1,
    });
    expect(typeof line?.fields.releaseId).toBe("string");
  });
});

describe("stop-then-start when blue's provider is the only one (task.5409)", () => {
  /** The actuator's NO_ELIGIBLE_BIDS text (akash-compute.adapter.ts awaitScreenedBid). */
  const refusal = (counts: string, roster: string) =>
    `bids arrived for dseq 9999 but none passed provider screening [refused: ${counts}] [bids: ${roster}]`;
  const ONLY = "provider-2";
  const noState = () => canaryApp({ bindings: [] });

  /** One admitted provider: every create lands on it; a create that excludes it is refused. */
  function singleProvider(h: H) {
    h.payer.providerFor = () => ONLY;
    h.payer.createFault = (_n, req) =>
      req.excludeProviders?.includes(ONLY)
        ? new PayerError(
            "provider_rejected",
            refusal(
              "not_allowlisted=9, already_tried=1",
              `${ONLY} US 1.00 already_tried, provider-9 DE 1.00 not_allowlisted`
            ),
            false
          )
        : undefined;
  }

  async function blueUp(h: H) {
    await h.release(noState(), SHA_1);
    expect(await h.seq.step(APP)).toBe("driven");
    const [blue] = await h.store.attemptsFor(APP);
    expect(blue?.phase).toBe("active");
    return blue;
  }

  /** bug.5569: blue on provider-1; attempt 1 of the next release binds on P=provider-2 and fails proof. */
  async function failedTryOnP(h: H, rosterNames: string) {
    const blue = await blueUp(h);
    expect(blue?.provider).toBe("provider-1");
    h.payer.onLease = (l) => {
      l.serveSha = "f".repeat(40);
    };
    await h.release(noState(), SHA_2);
    expect(await h.seq.step(APP)).toBe("driven"); // attempt 1: lease on provider-2, proof fails
    const tried = (await h.store.attemptsFor(APP)).find(
      (a) => a.phase === "failed"
    );
    expect(tried?.provider).toBe("provider-2");
    h.payer.onLease = undefined;
    // While blue AND the failed try are excluded, nothing passes screening; one bid was already_tried.
    h.payer.createFault = (_n, req) =>
      req.excludeProviders?.includes("provider-1") &&
      req.excludeProviders.includes("provider-2")
        ? new PayerError(
            "provider_rejected",
            refusal(
              "not_allowlisted=9, already_tried=1",
              `${rosterNames} US 1.00 already_tried, provider-9 DE 1.00 not_allowlisted`
            ),
            false
          )
        : undefined;
    return blue;
  }

  it("bug.5569: already_tried=1 naming the FAILED try's provider never closes blue", async () => {
    const h = harness();
    const blue = await failedTryOnP(h, "provider-2");
    expect(await h.seq.step(APP)).toBe("driven"); // attempt 2 refused, roster names P
    expect((await h.store.attemptsFor(APP))[0]?.error).toMatch(
      /^create refused: provider_rejected/
    );
    await h.seq.step(APP);
    expect(h.log.steps().some((st) => st.startsWith("stop_then_start"))).toBe(
      false
    );
    expect(h.events.some((e) => e.startsWith("payer.delete:1001"))).toBe(false);
    expect(h.payer.byDseq(blue?.externalName ?? "").state).toBe("active");
    expect(
      (await h.store.attemptsFor(APP)).find((a) => a.id === blue?.id)?.phase
    ).toBe("active");
  });

  it("bug.5569: already_tried=1 naming BLUE with a failed try excluded still proceeds to stop-then-start", async () => {
    const h = harness();
    const blue = await failedTryOnP(h, "provider-1");
    expect(await h.seq.step(APP)).toBe("driven"); // attempt 2 refused, roster names blue
    expect(await h.seq.step(APP)).toBe("driven");
    expect(h.log.steps()).toEqual(
      expect.arrayContaining(["stop_then_start:closing_blue"])
    );
    expect(h.payer.byDseq(blue?.externalName ?? "").state).toBe("closed");
  });

  it("task.5409: a long bid roster that names BLUE after 500 chars still proceeds to stop-then-start (no truncation)", async () => {
    const h = harness();
    const filler = Array.from(
      { length: 12 },
      (_, i) => `provider-${30 + i} US 1.00 not_allowlisted`
    ).join(", ");
    const blue = await failedTryOnP(h, `${filler}, provider-1`);
    expect(await h.seq.step(APP)).toBe("driven"); // attempt 2 refused, blue is late in the roster
    expect(
      ((await h.store.attemptsFor(APP))[0]?.error ?? "").length
    ).toBeGreaterThan(500);
    expect(await h.seq.step(APP)).toBe("driven");
    expect(h.log.steps()).toEqual(
      expect.arrayContaining(["stop_then_start:closing_blue"])
    );
    expect(h.payer.byDseq(blue?.externalName ?? "").state).toBe("closed");
  });

  it("second release on a single-provider lane: blue closed (confirmed), then green on the same provider, active", async () => {
    const h = harness();
    singleProvider(h);
    const blue = await blueUp(h);
    expect(blue?.provider).toBe(ONLY);

    await h.release(noState(), SHA_2);
    expect(await h.seq.step(APP)).toBe("driven"); // green create refused: blue's provider excluded
    let rows = await h.store.attemptsFor(APP);
    expect(rows[0]?.error).toMatch(/^create refused: provider_rejected/);
    expect(h.payer.byDseq(blue?.externalName ?? "").state).toBe("active");

    h.events.length = 0;
    expect(await h.seq.step(APP)).toBe("driven");
    rows = await h.store.attemptsFor(APP);
    const green = rows.find((a) => a.phase === "active");
    expect(green?.provider).toBe(ONLY);
    expect(rows.find((a) => a.id === blue?.id)?.phase).toBe("retired");
    expect(h.payer.byDseq(blue?.externalName ?? "").state).toBe("closed");
    // blue closed BEFORE the green create, and the green create no longer excludes blue's provider
    const del = h.events.indexOf(`payer.delete:${blue?.externalName}`);
    const create = h.events.findIndex((e) => e.startsWith("payer.create:"));
    expect(del).toBeGreaterThanOrEqual(0);
    expect(create).toBeGreaterThan(del);
    expect(h.payer.createRequests.at(-1)?.excludeProviders).toBeUndefined();
    expect(h.log.steps()).toEqual(
      expect.arrayContaining([
        "stop_then_start:closing_blue",
        "stop_then_start:blue_closed",
        "activated:ok",
      ])
    );
    expect(h.log.alerts()).toContain("stop_then_start");
    expect([...h.dns.records.values()][0]?.content).toBe(
      `ingress-${green?.externalName}.${ONLY}.example`
    );
  });

  it("an unconfirmed blue close creates nothing; the next tick retries and then starts green", async () => {
    const h = harness({ closeConfirmMs: 5_000 });
    singleProvider(h);
    const blue = await blueUp(h);
    await h.release(noState(), SHA_2);
    await h.seq.step(APP); // refused
    const creates = h.payer.createRequests.length;
    h.payer.failDelete = true;
    expect(await h.seq.step(APP)).toBe("close_pending");
    expect(h.payer.createRequests).toHaveLength(creates);
    expect(
      (await h.store.attemptsFor(APP)).find((a) => a.id === blue?.id)?.phase
    ).toBe("active");
    expect(h.log.alerts()).toContain("close_unconfirmed");
    h.payer.failDelete = false;
    expect(await h.seq.step(APP)).toBe("driven");
    expect((await h.store.attemptsFor(APP))[0]?.phase).toBe("active");
  });

  it("at most one stop-then-start per release: a failing green then parks normally", async () => {
    const h = harness();
    singleProvider(h);
    const blue = await blueUp(h);
    await h.release(noState(), SHA_2);
    h.payer.onLease = (l) => {
      l.serveSha = "f".repeat(40); // every green serves the wrong sha
    };
    for (let i = 0; i < 6; i++) await h.seq.step(APP);
    expect(await h.seq.step(APP)).toBe("parked");
    expect(
      h.log.steps().filter((s) => s === "stop_then_start:closing_blue")
    ).toHaveLength(1);
    expect(
      h.events.filter((e) => e === `payer.delete:${blue?.externalName}`)
    ).toHaveLength(1);
  });

  it("first release of a workload (no blue) is unaffected: a refusal just retries", async () => {
    const h = harness();
    h.payer.createFault = (n) =>
      n === 1
        ? new PayerError(
            "provider_rejected",
            refusal("already_tried=1", `${ONLY} US 1.00 already_tried`),
            false
          )
        : undefined;
    await h.release(noState(), SHA_1);
    await h.seq.step(APP);
    expect(await h.seq.step(APP)).toBe("driven");
    expect((await h.store.attemptsFor(APP))[0]?.phase).toBe("active");
    expect(h.log.steps().some((s) => s.startsWith("stop_then_start"))).toBe(
      false
    );
    expect(h.events.some((e) => e.startsWith("payer.delete"))).toBe(false);
  });

  it("multi-provider lane is unaffected: green elsewhere, blue retained; a refusal without already_tried never stops blue", async () => {
    const h = harness();
    const blue = await blueUp(h);
    h.payer.createFault = (n) =>
      n === 2
        ? new PayerError(
            "provider_rejected",
            refusal("quality=2", "provider-7 US 1.00 quality"),
            false
          )
        : undefined;
    await h.release(noState(), SHA_2);
    await h.seq.step(APP); // refused, but not for blue's exclusion
    await h.seq.step(APP);
    const rows = await h.store.attemptsFor(APP);
    expect(rows.map((a) => a.phase)).toEqual(["active", "failed", "retiring"]);
    expect(h.payer.createRequests.at(-1)?.excludeProviders).toEqual([
      blue?.provider,
    ]);
    expect(h.payer.byDseq(blue?.externalName ?? "").state).toBe("active");
    expect(h.log.alerts()).not.toContain("stop_then_start");
  });

  it("bound state on another provider: the roster must name blue as already_tried; the state provider stays excluded", async () => {
    const h = harness();
    await stateUp(h); // provider-1
    await deployApp(h, SHA_1); // blue on provider-2
    h.payer.providerFor = () => ONLY;
    h.payer.createFault = (_n, req) =>
      req.excludeProviders?.includes(ONLY)
        ? new PayerError(
            "provider_rejected",
            refusal(
              "already_tried=2",
              `provider-1 US 1.00 already_tried, ${ONLY} US 1.00 already_tried`
            ),
            false
          )
        : undefined;
    await deployApp(h, SHA_2); // refused
    expect(await h.seq.step(APP)).toBe("driven");
    const active = (await h.store.attemptsFor(APP)).find(
      (a) => a.phase === "active"
    );
    expect(active?.provider).toBe(ONLY);
    expect(h.payer.createRequests.at(-1)?.excludeProviders).toEqual([
      "provider-1",
    ]);
  });

  it("a roster cut off by the actuator payer's 400-char truncation still names blue", async () => {
    const h = harness();
    await stateUp(h); // provider-1
    await deployApp(h, SHA_1); // blue on provider-2
    const filler = Array.from(
      { length: 20 },
      (_, i) => `provider-x${i} DE 1.00 not_allowlisted`
    ).join(", ");
    // Same shape as actuator-payer.adapter.ts: `actuator <path> -> HTTP <s> <code>: <message>`.slice(0, 400)
    const truncated =
      `actuator /v1/create -> HTTP 422 provider_rejected: ${refusal(
        "not_allowlisted=20, already_tried=2",
        `provider-1 US 1.00 already_tried, ${ONLY} US 1.00 already_tried, ${filler}`
      )}`.slice(0, 400);
    expect(truncated).not.toMatch(/\]$/);
    h.payer.providerFor = () => ONLY;
    h.payer.createFault = (_n, req) =>
      req.excludeProviders?.includes(ONLY)
        ? new PayerError("provider_rejected", truncated, false)
        : undefined;
    await deployApp(h, SHA_2); // refused
    expect(await h.seq.step(APP)).toBe("driven");
    expect(h.log.steps()).toContain("stop_then_start:blue_closed");
    const active = (await h.store.attemptsFor(APP)).find(
      (a) => a.phase === "active"
    );
    expect(active?.provider).toBe(ONLY);
  });

  it("blue's provider no longer admitted (appProviders): alert, blue kept, no stop", async () => {
    const h = harness({ appProviders: ["provider-7"] });
    singleProvider(h);
    const blue = await blueUp(h);
    await h.release(noState(), SHA_2);
    await h.seq.step(APP); // refused
    await h.seq.step(APP);
    expect(h.log.alerts()).toContain("stop_then_start_refused");
    expect(h.log.steps().some((s) => s.startsWith("stop_then_start"))).toBe(
      false
    );
    expect(h.payer.byDseq(blue?.externalName ?? "").state).toBe("active");
    expect(
      (await h.store.attemptsFor(APP)).find((a) => a.id === blue?.id)?.phase
    ).toBe("active");
  });

  it("a state workload is never stopped", async () => {
    const h = harness();
    await stateUp(h);
    await h.release(canaryDb({ memoryMi: 1024 }), SHA_2);
    expect(await h.seq.step(DB)).toBe("state_protected");
    expect(h.events.some((e) => e.startsWith("payer.delete"))).toBe(false);
  });

  it("a refused create whose observe stays down fails as plain `create refused:`, not orphan_suspect (bug.5567)", async () => {
    const h = harness();
    await stateUp(h);
    h.payer.createFault = (n) =>
      n === 2
        ? new PayerError("provider_rejected", "bid refused", false)
        : undefined;
    h.payer.observeThrows = true;
    await deployApp(h, SHA_1);
    await h.seq.step(APP); // the observe-unavailable clock is running
    h.clock.advance(16 * 60_000);
    await h.seq.step(APP);
    const first = (await h.store.attemptsFor(APP)).find((a) => a.attempt === 1);
    expect(first?.phase).toBe("failed");
    expect(first?.error).toMatch(/^create refused: provider_rejected/);
    expect(
      h.payer.createRequests.filter((r) => r.cogniKey === first?.cogniKey)
    ).toHaveLength(1);
  });
});
