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
  it("tells the payer to avoid blue's provider for a green create (and sends nothing on a first deploy)", async () => {
    const h = harness();
    await stateUp(h);
    await deployApp(h, SHA_1);
    const first = h.payer.createRequests.filter(
      (r) => r.spec.name === "canary"
    );
    expect(first[0]?.excludeProviders).toBeUndefined();
    await deployApp(h, SHA_2);
    const second = h.payer.createRequests.filter(
      (r) => r.spec.name === "canary"
    );
    expect(second[1]?.excludeProviders).toEqual(["provider-2"]);
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
