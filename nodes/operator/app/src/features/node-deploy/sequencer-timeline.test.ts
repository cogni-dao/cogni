// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/sequencer-timeline.test`
 * Purpose: Prove the durable step timeline (task.5400 observability) on the REAL sequencer over fakes:
 *   every `node_deploy_step` log has its persisted twin because ONE helper writes both, a failing
 *   timeline store never fails a deploy, and the derived release state (`active`, `parked`,
 *   `superseded`) and lead time read back through the same builders the routes use.
 * Side-effects: none
 */

import { describe, expect, it } from "vitest";
import { DeployWorkloadViewSchema } from "@/contracts/deploy.workloads.v1.contract";
import type { NodeWorkloadSpec } from "@/ports";
import { EdgeRouter } from "./edge";
import { buildReleaseDetail, buildWorkloadView } from "./release-view";
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
  SHA_1,
  SHA_2,
  WORKLOAD_ZONE,
} from "./testing";

const DB = { nodeId: NODE_ID, env: ENV, workload: "canary-db" };
const APP = { nodeId: NODE_ID, env: ENV, workload: "canary" };

function harness(cfg: Partial<SequencerConfig> = {}) {
  const events: string[] = [];
  const clock = new FakeClock();
  const store = new MemoryStore(clock);
  const payer = new FakePayer(events);
  const dns = new FakeDns(events);
  const probe = new FakeProbe(payer, dns, events);
  const log = new MemoryLog();
  const seq = new NodeDeploySequencer({
    store,
    payer,
    edge: new EdgeRouter(dns, WORKLOAD_ZONE),
    probe,
    secrets: new MemorySecrets(),
    chain: new FakeChain(payer),
    clock,
    log,
    config: {
      ...DEFAULT_SEQUENCER_CONFIG,
      namespace: "cogni-production",
      environment: ENV,
      retainMs: 120_000,
      ...cfg,
    },
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
  return { clock, store, payer, log, seq, release };
}

type H = ReturnType<typeof harness>;

async function view(h: H) {
  const desired = await h.store.getDesired(APP);
  if (!desired) throw new Error("no desired");
  return buildWorkloadView({
    desired,
    release: await h.store.getRelease(desired.releaseId),
    attemptsNewestFirst: await h.store.attemptsFor(APP),
  });
}

async function stateUp(h: H) {
  await h.release(canaryDb(), SHA_1);
  await h.seq.step(DB);
}

/**
 * bug.5587: a step makes ONE proof round or public read; step `pollMs` apart (a tick) until the app
 * attempt leaves `proving` / `proven`.
 */
async function stepUntilSettled(h: H) {
  for (let i = 0; i < 10_000; i++) {
    const outcome = await h.seq.step(APP);
    const phase = (await h.store.attemptsFor(APP))[0]?.phase;
    if (phase !== "proving" && phase !== "proven") return outcome;
    h.clock.advance(DEFAULT_SEQUENCER_CONFIG.pollMs);
  }
  throw new Error("still proving");
}

describe("persisted step timeline", () => {
  it("every persisted step has its node_deploy_step log twin (one emit helper)", async () => {
    const h = harness();
    await stateUp(h);
    await h.release(canaryApp(), SHA_1);
    await stepUntilSettled(h);
    const [attempt] = await h.store.attemptsFor(APP);
    expect(attempt?.steps.map((s) => s.step)).toEqual([
      "attempt_planned",
      "providers_excluded",
      "created",
      "lease_active",
      "proven",
      "edge_moved",
      "public_readback",
      "activated",
    ]);
    const logged = h.log.lines
      .filter(
        (l) =>
          l.msg === "node_deploy_step" &&
          l.fields.workload === "canary" &&
          l.fields.attempt === 1
      )
      .map((l) => `${String(l.fields.step)}:${String(l.fields.outcome)}`);
    expect(attempt?.steps.map((s) => `${s.step}:${s.outcome}`)).toEqual(logged);
    // dseq and provider ride on the step; `at` is the sequencer clock, ISO.
    const created = attempt?.steps.find((s) => s.step === "created");
    expect(created).toMatchObject({ dseq: "1002", provider: "provider-2" });
    // step latency and lead time ride on BOTH the log line and the persisted step (Grafana unwraps them)
    const activated = attempt?.steps.find((s) => s.step === "activated");
    expect(activated?.elapsedMs).toBeGreaterThan(0);
    const activatedLog = h.log.lines.find(
      (l) =>
        l.msg === "node_deploy_step" &&
        l.fields.step === "activated" &&
        l.fields.workload === "canary"
    );
    expect(activatedLog?.fields.elapsedMs).toBe(activated?.elapsedMs);
    expect(activatedLog?.fields.leadTimeMs).toBeGreaterThan(0);
    expect(attempt?.steps.every((s) => !Number.isNaN(Date.parse(s.at)))).toBe(
      true
    );
  });

  it("activation writes a write-once activatedAt equal to the activated step (task.5442)", async () => {
    const h = harness();
    await stateUp(h);
    await h.release(canaryApp(), SHA_1);
    await stepUntilSettled(h);
    const [attempt] = await h.store.attemptsFor(APP);
    const step = attempt?.steps.find((s) => s.step === "activated");
    expect(attempt?.phase).toBe("active");
    expect(attempt?.activatedAt?.toISOString()).toBe(step?.at);
    // A later activation write never moves the first instant.
    h.clock.advance(60_000);
    const again = await h.store.updateAttempt(attempt?.id ?? "", {
      activatedAt: new Date(h.clock.now()),
    });
    expect(again.activatedAt?.toISOString()).toBe(step?.at);
    const detail = buildWorkloadView({
      desired: {
        workload: "canary",
        state: "running",
        releaseId: again.releaseId,
      },
      release: (await h.store.getRelease(again.releaseId)) ?? undefined,
      attemptsNewestFirst: [again],
    });
    expect(detail.active?.activatedAt).toBe(step?.at);
    expect(DeployWorkloadViewSchema.safeParse(detail).success).toBe(true);
  });

  it("a failing timeline store NEVER fails or stalls the deploy; it logs node_deploy_step_persist_failed", async () => {
    const h = harness();
    await stateUp(h);
    h.store.failStepAppends = true;
    await h.release(canaryApp(), SHA_1);
    expect(await stepUntilSettled(h)).toBe("driven");
    const [attempt] = await h.store.attemptsFor(APP);
    expect(attempt?.phase).toBe("active");
    expect(attempt?.steps).toEqual([]);
    expect(
      h.log.lines.some((l) => l.msg === "node_deploy_step_persist_failed")
    ).toBe(true);
    // the Loki line is still written for every step
    expect(h.log.steps()).toContain("activated:ok");
  });

  it("strikes and failures carry their reason, provider and dseq on the attempt", async () => {
    const h = harness();
    await stateUp(h);
    h.payer.onLease = (l) => {
      l.serveSha = "f".repeat(40);
    };
    await h.release(canaryApp(), SHA_1);
    await stepUntilSettled(h);
    const [attempt] = await h.store.attemptsFor(APP);
    const strike = attempt?.steps.find((s) => s.step === "provider_strike");
    expect(strike).toMatchObject({
      outcome: "proof_timeout",
      provider: attempt?.provider,
      dseq: attempt?.externalName,
    });
    expect(
      attempt?.steps.find((s) => s.step === "attempt_failed")?.reason
    ).toMatch(/proof_timeout/);
    // a poll loop is not a row per poll: no two consecutive identical steps
    const sigs = (attempt?.steps ?? []).map(
      (s) => `${s.step}|${s.outcome}|${s.reason ?? ""}`
    );
    for (let i = 1; i < sigs.length; i++) expect(sigs[i]).not.toBe(sigs[i - 1]);
  });
});

describe("release state on the read model", () => {
  it("queued before any attempt, then active with a lead time after the deploy", async () => {
    const h = harness();
    await stateUp(h);
    await h.release(canaryApp(), SHA_1);
    const queued = await view(h);
    expect(queued.desired).toMatchObject({
      releaseState: "queued",
      parkedReason: null,
      startedAt: null,
      activatedAt: null,
      leadTimeMs: null,
    });
    await stepUntilSettled(h);
    const done = await view(h);
    expect(done.desired.releaseState).toBe("active");
    expect(done.desired.activatedAt).not.toBeNull();
    expect(done.desired.startedAt).not.toBeNull();
    expect(done.desired.leadTimeMs).toBeGreaterThan(0);
    expect(done.active?.steps.map((s) => s.step)).toContain("activated");
    expect(DeployWorkloadViewSchema.safeParse(done).success).toBe(true);
  });

  it("a PARKED release is explicit: state parked, the reason names the last failure, no further create", async () => {
    const h = harness();
    await stateUp(h);
    h.payer.onLease = (l) => {
      l.serveSha = "f".repeat(40);
    };
    await h.release(canaryApp(), SHA_1);
    const states: string[] = [];
    for (let i = 0; i < 4; i++) {
      await stepUntilSettled(h);
      states.push((await view(h)).desired.releaseState);
      h.clock.advance(60_000);
    }
    // after attempts 1-3 the release is retrying; the NEXT tick writes the sequencer's park verdict
    // (a count alone is not a park)
    expect(states).toEqual(["failed", "failed", "failed", "parked"]);
    const v = await view(h);
    expect(v.desired.parkedReason).toMatch(
      /^3 consecutive failed attempts; last: proof_timeout/
    );
    // the park is a durable step on the newest attempt (the verdict release-view reads)
    expect(
      v.recentAttempts[0]?.steps.some(
        (s) => s.step === "alert" && s.outcome === "release_parked"
      )
    ).toBe(true);
    expect(v.recentAttempts.map((a) => a.attempt)).toEqual([3, 2, 1]);
    expect(v.recentAttempts.every((a) => a.phase === "failed")).toBe(true);
    expect(DeployWorkloadViewSchema.safeParse(v).success).toBe(true);
  });

  it("a newer release supersedes the old one, which keeps its activation record; detail lists its attempts", async () => {
    const h = harness();
    await stateUp(h);
    await h.release(canaryApp(), SHA_1);
    await stepUntilSettled(h);
    const first = (await h.store.getDesired(APP))?.releaseId ?? "";
    await h.release(canaryApp(), SHA_2);
    await stepUntilSettled(h);
    const desired = await h.store.getDesired(APP);
    const release = await h.store.getRelease(first);
    if (!release) throw new Error("missing release");
    const detail = buildReleaseDetail({
      release,
      desired,
      attemptsNewestFirst: await h.store.attemptsFor(APP),
    });
    expect(detail.release).toMatchObject({
      releaseId: first,
      current: false,
      releaseState: "superseded",
    });
    expect(detail.release.activatedAt).not.toBeNull();
    expect(detail.release.leadTimeMs).toBeGreaterThan(0);
    expect(detail.attempts.map((a) => a.releaseId)).toEqual([first]);
    expect((await view(h)).desired.releaseState).toBe("active");
  });
});
