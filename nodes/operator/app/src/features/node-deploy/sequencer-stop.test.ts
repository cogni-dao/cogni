// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/sequencer-stop.test`
 * Purpose: Prove STOPPED_HAS_NO_LEASE over the real sequencer and fakes (task.5491): an app lease closes
 *   and is read back from the chain; a retained (`state`) lease closes only under a stored, dseq-matched,
 *   audited destroy; the janitor never sends an unflagged close for retained storage; a stop never
 *   alerts for being stopped; a restart replays the intent.
 * Side-effects: none
 */

import { describe, expect, it } from "vitest";
import type { NodeWorkloadSpec } from "@/ports";
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
  SHA_1,
  SHA_2,
  WORKLOAD_ZONE,
} from "./testing";

const DB = { nodeId: NODE_ID, env: ENV, workload: "canary-db" };
const APP = { nodeId: NODE_ID, env: ENV, workload: "canary" };
const BY = "user:11111111-1111-4111-8111-111111111111";

function harness(cfg: Partial<SequencerConfig> = {}) {
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
    publicStreak: 1,
    ...cfg,
  };
  const deps = {
    store,
    payer,
    edge: new EdgeRouter(dns, WORKLOAD_ZONE),
    probe,
    secrets,
    chain,
    clock,
    log,
    config,
  };
  const seq = new NodeDeploySequencer(deps);
  const restart = () => new NodeDeploySequencer(deps);
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
    chain,
    log,
    seq,
    release,
    config,
    restart,
  };
}
type H = ReturnType<typeof harness>;

/** State lease 1001 active; retained like the real actuator (an unflagged delete is refused). */
async function stateUp(h: H) {
  await h.release(canaryDb(), SHA_1);
  expect(await h.seq.step(DB)).toBe("driven");
  h.payer.retained.add("1001");
}

async function settle(h: H, key = APP) {
  for (let i = 0; i < 10_000; i++) {
    const outcome = await h.seq.step(key);
    const phase = (await h.store.attemptsFor(key))[0]?.phase;
    if (phase !== "proving" && phase !== "proven" && phase !== "planned")
      return outcome;
    h.clock.advance(h.config.pollMs);
  }
  throw new Error("did not settle");
}

async function appUp(h: H) {
  await stateUp(h);
  await h.release(canaryApp(), SHA_1);
  await settle(h); // app lease 1002 active
}

const stop = async (
  h: H,
  key: typeof APP,
  destroyDseq?: string,
  by = BY
): Promise<void> => {
  const d = await h.store.getDesired(key);
  const r = await h.store.requestStop(key, {
    by,
    releaseId: d?.releaseId ?? "",
    destroyDseq,
  });
  expect(r.ok).toBe(true);
};
const phasesOf = async (h: H, key: typeof APP) =>
  (await h.store.attemptsFor(key)).map((a) => a.phase);
const stepsOf = async (h: H, key: typeof APP) =>
  (await h.store.attemptsFor(key)).flatMap((a) =>
    a.steps.map((s) => s.step + ":" + s.outcome)
  );

describe("stop an app (STOPPED_HAS_NO_LEASE)", () => {
  it("closes the lease, reads the chain, retires the attempt and creates nothing", async () => {
    const h = harness();
    await appUp(h);
    const creates = h.payer.createRequests.length;
    await stop(h, APP);
    h.events.length = 0;
    expect(await h.seq.step(APP)).toBe("stopped");
    expect(h.events).toContain("payer.delete:1002");
    expect(h.payer.byDseq("1002").state).toBe("closed");
    expect(await phasesOf(h, APP)).toEqual(["retired"]);
    expect(await stepsOf(h, APP)).toContain("workload_stopped:ok");
    expect(h.payer.createRequests).toHaveLength(creates);
    // idempotent: a second pass sends nothing and raises nothing
    h.events.length = 0;
    expect(await h.seq.step(APP)).toBe("stopped");
    expect(h.events).toEqual([]);
    expect(h.log.alerts()).toEqual([]);
    expect(await h.seq.reconcile(APP)).toBe("none");
  });

  it("an unconfirmed close is retried, alerts only when overdue, and settles once the chain agrees", async () => {
    const h = harness();
    await appUp(h);
    await stop(h, APP);
    h.payer.failDelete = true;
    expect(await h.seq.step(APP)).toBe("close_pending");
    expect(h.log.alerts()).toEqual([]);
    h.clock.advance(h.config.closeConfirmMs);
    expect(await h.seq.step(APP)).toBe("close_pending");
    expect(h.log.alerts()).toContain("close_unconfirmed");
    h.payer.failDelete = false;
    h.clock.advance(h.config.closeConfirmMs);
    expect(await h.seq.step(APP)).toBe("stopped");
    expect(await phasesOf(h, APP)).toEqual(["retired"]);
  });

  it("a restart replays the durable intent with none of the old runner's memory", async () => {
    const h = harness();
    await appUp(h);
    await stop(h, APP);
    h.payer.failDelete = true;
    expect(await h.seq.step(APP)).toBe("close_pending");
    h.payer.failDelete = false;
    expect(await h.restart().step(APP)).toBe("stopped");
    expect(h.payer.byDseq("1002").state).toBe("closed");
  });

  it("an attempt still proving is failed and its lease closed", async () => {
    const h = harness();
    await appUp(h);
    const [live] = await h.store.attemptsFor(APP);
    await h.store.updateAttempt(live?.id ?? "", { phase: "proving" }); // the lease exists, proof not done
    await stop(h, APP);
    for (let i = 0; i < 5; i++) {
      h.clock.advance(h.config.closeConfirmMs);
      if ((await h.seq.step(APP)) === "stopped") break;
    }
    expect(await phasesOf(h, APP)).toEqual(["failed"]);
    expect(h.payer.liveLeases().map((l) => l.dseq)).toEqual(["1001"]); // only the retained state remains
  });

  it("a stop recorded while the sequencer pins the image allocates no attempt", async () => {
    const h = harness();
    await stateUp(h);
    await h.release(canaryApp(), SHA_1);
    // The stop lands after the sequencer's first read of the row: its re-read before insertAttempt sees it.
    const real = h.store.getDesired.bind(h.store);
    let reads = 0;
    h.store.getDesired = async (key) => {
      const row = await real(key);
      if (key.workload === "canary" && row && ++reads === 2) await stop(h, APP);
      return key.workload === "canary" ? real(key) : row;
    };
    const first = await real(APP);
    expect(first?.state).toBe("running");
    expect(await h.seq.step(APP)).toBe("idle");
    expect(await h.store.attemptsFor(APP)).toHaveLength(0);
    expect(
      h.payer.createRequests.filter((r) => r.spec.name === "canary")
    ).toHaveLength(0);
  });

  it("a deploy POST after a stop starts a new release; the stop record and a stale game-day are gone", async () => {
    const h = harness();
    await appUp(h);
    await h.store.requestGameDay(APP);
    await stop(h, APP);
    expect((await h.store.getDesired(APP))?.gameDayRequestedAt).toBeUndefined();
    expect(await h.seq.step(APP)).toBe("stopped");
    expect(await h.store.requestGameDay(APP)).toBe(false); // refused while stopped
    await h.release(canaryApp(), SHA_2);
    const again = await h.store.getDesired(APP);
    expect(again?.state).toBe("running");
    expect(again?.stop).toBeUndefined();
    expect(await settle(h)).not.toBe("stopped");
    expect(h.payer.liveLeases().some((l) => l.dseq !== "1001")).toBe(true);
  });

  it("a stopped row with no open lease costs no alert and no payer call", async () => {
    const h = harness();
    await h.release(canaryApp(), SHA_1);
    await stop(h, APP);
    expect(await h.seq.step(APP)).toBe("stopped");
    expect(h.events).toEqual([]);
    expect(h.log.alerts()).toEqual([]);
  });
});

describe("stop retained state (destroy)", () => {
  it("a plain stop sends no close and alerts state_stop_without_destroy", async () => {
    const h = harness();
    await stateUp(h);
    await stop(h, DB);
    expect(await h.seq.step(DB)).toBe("close_pending");
    expect(h.payer.deleteRequests).toEqual([]);
    expect(h.log.alerts()).toContain("state_stop_without_destroy");
    expect(h.payer.byDseq("1001").state).toBe("active");
  });

  it("a matching destroy saves the audit step first, then closes with the flag and retires the attempt", async () => {
    const h = harness();
    await stateUp(h);
    await stop(h, DB, "1001");
    h.events.length = 0;
    expect(await h.seq.step(DB)).toBe("stopped");
    expect(h.payer.deleteRequests).toEqual([
      { externalName: "1001", destroyRetainedData: true },
    ]);
    const [attempt] = await h.store.attemptsFor(DB);
    const audit = attempt?.steps.find((s) => s.step === "retained_destroy");
    expect(audit).toMatchObject({ outcome: "authorized", dseq: "1001" });
    expect(audit?.reason).toContain(BY);
    expect(attempt?.phase).toBe("retired");
    expect(await stepsOf(h, DB)).toContain("workload_stopped:ok");
    expect(
      h.log.lines.some((l) => l.msg === "node_deploy_retained_destroy")
    ).toBe(true);
    expect(h.payer.byDseq("1001").state).toBe("closed");
  });

  it("sends nothing when the audit step cannot be saved", async () => {
    const h = harness();
    await stateUp(h);
    await stop(h, DB, "1001");
    h.store.appendAttemptStep = async () => {
      throw new Error("db down");
    };
    await expect(h.seq.step(DB)).rejects.toThrow("db down");
    expect(h.payer.deleteRequests).toEqual([]);
    expect(h.payer.byDseq("1001").state).toBe("active");
  });

  it("a destroy for another dseq does not close this lease", async () => {
    const h = harness();
    await stateUp(h);
    await stop(h, DB, "9999");
    expect(await h.seq.step(DB)).toBe("close_pending");
    expect(h.payer.deleteRequests).toEqual([]);
    expect(h.log.alerts()).toContain("state_stop_without_destroy");
  });

  it("a state lease the chain already closed ends quietly: no close, no alert", async () => {
    const h = harness();
    await stateUp(h);
    h.payer.byDseq("1001").state = "closed";
    await stop(h, DB);
    expect(await h.seq.step(DB)).toBe("stopped");
    expect(h.payer.deleteRequests).toEqual([]);
    expect(h.log.alerts()).toEqual([]);
    expect(await phasesOf(h, DB)).toEqual(["retired"]);
    expect(await stepsOf(h, DB)).toContain("workload_stopped:already_closed");
  });

  it("an expired destroy is not started; a renewed one is", async () => {
    const h = harness();
    await stateUp(h);
    await stop(h, DB, "1001");
    h.clock.advance(2 * 3_600_000);
    expect(await h.seq.step(DB)).toBe("close_pending");
    expect(h.log.alerts()).toContain("state_destroy_expired");
    expect(h.payer.deleteRequests).toEqual([]);
    await stop(h, DB, "1001", "user:renewer");
    expect(await h.seq.step(DB)).toBe("stopped");
    const audit = (await h.store.attemptsFor(DB))[0]?.steps.find(
      (s) => s.step === "retained_destroy"
    );
    expect(audit?.reason).toContain("user:renewer"); // the destroyer, not the first stopper
    expect((await h.store.getDesired(DB))?.stop).toMatchObject({
      requestedBy: BY,
      destroy: { dseq: "1001", by: "user:renewer" },
    });
  });

  it("a running consumer blocks the destroy before the first close", async () => {
    const h = harness();
    await appUp(h); // canary binds canary-db
    await stop(h, DB, "1001");
    expect(await h.seq.step(DB)).toBe("close_pending");
    expect(h.log.alerts()).toContain("state_in_use_at_destroy");
    expect(h.payer.deleteRequests).toEqual([]);
    expect(await stepsOf(h, DB)).not.toContain("retained_destroy:authorized");
  });

  it("a consumer that starts after the first close does not stop the destroy from finishing", async () => {
    const h = harness();
    await stateUp(h);
    await stop(h, DB, "1001");
    h.payer.failDelete = true; // the close is sent but not confirmed
    expect(await h.seq.step(DB)).toBe("close_pending");
    expect(await stepsOf(h, DB)).toContain("retained_destroy:authorized");
    await h.release(canaryApp(), SHA_1); // a consumer appears
    h.payer.failDelete = false;
    h.clock.advance(h.config.closeConfirmMs);
    expect(await h.seq.step(DB)).toBe("stopped");
  });

  it("a refused destroy is recorded, alerts, and is not resent until a newer call", async () => {
    const h = harness();
    await stateUp(h);
    h.payer.refuseDestroy.add("1001");
    await stop(h, DB, "1001");
    expect(await h.seq.step(DB)).toBe("close_pending");
    expect(h.log.alerts()).toContain("state_destroy_refused");
    expect(await stepsOf(h, DB)).toContain("retained_destroy:refused");
    expect(h.payer.deleteRequests).toHaveLength(1);
    for (let i = 0; i < 3; i++) {
      h.clock.advance(h.config.closeConfirmMs);
      await h.seq.step(DB);
    }
    expect(h.payer.deleteRequests).toHaveLength(1); // not resent
    h.payer.refuseDestroy.clear();
    await stop(h, DB, "1001", "user:renewer"); // a newer destroy renews it
    expect(await h.seq.step(DB)).toBe("stopped");
    expect(h.payer.deleteRequests).toHaveLength(2);
  });

  it("refused twice within ten minutes: BOTH refusals are saved, and nothing is resent between calls", async () => {
    const h = harness();
    await stateUp(h);
    h.payer.refuseDestroy.add("1001");
    await stop(h, DB, "1001");
    expect(await h.seq.step(DB)).toBe("close_pending");
    h.clock.advance(60_000); // well inside the 10 minute alert throttle
    await stop(h, DB, "1001"); // a renewal
    expect(await h.seq.step(DB)).toBe("close_pending");
    const refused = (await h.store.attemptsFor(DB))[0]?.steps.filter(
      (x) => x.step === "retained_destroy" && x.outcome === "refused"
    );
    expect(refused).toHaveLength(2);
    expect(new Set(refused?.map((x) => x.reason)).size).toBe(2); // each names its own destroy time
    expect(h.payer.deleteRequests).toHaveLength(2); // one send per destroy call
    for (let i = 0; i < 3; i++) {
      h.clock.advance(h.config.closeConfirmMs);
      await h.seq.step(DB);
    }
    expect(h.payer.deleteRequests).toHaveLength(2);
  });

  it("a renewal by a second caller saves a new audit step naming that caller BEFORE the send", async () => {
    const h = harness();
    await stateUp(h);
    h.payer.refuseDestroy.add("1001");
    await stop(h, DB, "1001", "user:first");
    await h.seq.step(DB); // refused
    h.payer.refuseDestroy.clear();
    h.clock.advance(60_000);
    await stop(h, DB, "1001", "user:second");
    const real = h.store.appendAttemptStep.bind(h.store);
    h.store.appendAttemptStep = async (id, step) => {
      h.events.push(`step:${step.step}:${step.outcome}:${step.reason ?? ""}`);
      return real(id, step);
    };
    h.events.length = 0;
    expect(await h.seq.step(DB)).toBe("stopped");
    const authorized = (await h.store.attemptsFor(DB))[0]?.steps.filter(
      (x) => x.step === "retained_destroy" && x.outcome === "authorized"
    );
    expect(authorized).toHaveLength(2);
    expect(authorized?.[0]?.reason).toContain("user:first");
    expect(authorized?.[1]?.reason).toContain("user:second");
    const saved = h.events.findIndex(
      (e) =>
        e.startsWith("step:retained_destroy:authorized:") &&
        e.includes("user:second")
    );
    const sent = h.events.indexOf("payer.delete:1001");
    expect(saved).toBeGreaterThanOrEqual(0);
    expect(sent).toBeGreaterThan(saved);
  });

  it("an unreadable destroy time is treated as expired: nothing is sent", async () => {
    const h = harness();
    await stateUp(h);
    await stop(h, DB, "1001");
    const row = await h.store.getDesired(DB);
    if (!row?.stop?.destroy) throw new Error("fixture destroy absent");
    (row as { stop: unknown }).stop = {
      ...row.stop,
      destroy: { ...row.stop.destroy, at: "not a time" },
    };
    expect(await h.seq.step(DB)).toBe("close_pending");
    expect(h.log.alerts()).toContain("state_destroy_expired");
    expect(h.payer.deleteRequests).toEqual([]);
    expect(await stepsOf(h, DB)).not.toContain("retained_destroy:authorized");
  });

  it("a state attempt in `created` or `proven` with a lease id is destroyed too, and a restart after the audit step finishes the close", async () => {
    for (const phase of ["created", "proven"] as const) {
      const h = harness();
      await stateUp(h);
      const [a] = await h.store.attemptsFor(DB);
      await h.store.updateAttempt(a?.id ?? "", { phase });
      await stop(h, DB, "1001");
      h.payer.failDelete = true; // the close is sent but not confirmed
      expect(await h.seq.step(DB)).toBe("close_pending");
      expect(await stepsOf(h, DB)).toContain("retained_destroy:authorized");
      h.payer.failDelete = false;
      expect(await h.restart().step(DB)).toBe("stopped");
      const authorized = (await h.store.attemptsFor(DB))[0]?.steps.filter(
        (x) => x.step === "retained_destroy" && x.outcome === "authorized"
      );
      expect(authorized).toHaveLength(1); // the restart did not write the audit again
    }
  });

  it("a state attempt in `proving` with a lease id is destroyed like an active one", async () => {
    const h = harness();
    await stateUp(h);
    const [a] = await h.store.attemptsFor(DB);
    await h.store.updateAttempt(a?.id ?? "", { phase: "proving" });
    await stop(h, DB, "1001");
    expect(await h.seq.step(DB)).toBe("stopped");
    expect(h.payer.deleteRequests).toEqual([
      { externalName: "1001", destroyRetainedData: true },
    ]);
  });

  it("a state attempt with no lease id waits for the create, then fails without a close", async () => {
    const h = harness();
    const { release } = await h.release(canaryDb(), SHA_1);
    await h.store.insertAttempt(
      release.id,
      (n) => `nd:cogni-production:${NODE_ID}:canary-db:${release.id}:${n}`
    );
    await stop(h, DB);
    expect(await h.seq.step(DB)).toBe("close_pending"); // the create may still land
    expect(h.payer.deleteRequests).toEqual([]);
    h.clock.advance(h.config.inflightGraceMs + 1);
    expect(await h.seq.step(DB)).toBe("stopped");
    expect(await phasesOf(h, DB)).toEqual(["failed"]);
    expect(h.payer.deleteRequests).toEqual([]);
  });

  it("the janitor never sends a close for a RUNNING state attempt stuck in `closing`, but it alerts", async () => {
    const h = harness();
    await stateUp(h);
    const [a] = await h.store.attemptsFor(DB);
    await h.store.updateAttempt(a?.id ?? "", { phase: "closing", error: "x" });
    expect(await h.seq.step(DB)).toBe("close_pending");
    expect(h.payer.deleteRequests).toEqual([]);
    expect(h.log.alerts()).not.toContain("state_close_not_sent_retained");
    h.clock.advance(h.config.closeAlertMs);
    await h.seq.step(DB);
    expect(h.log.alerts()).toContain("state_close_not_sent_retained");
    expect(h.payer.deleteRequests).toEqual([]);
  });

  it("the janitor still reads closure for a retained `closing` attempt whose lease closed on chain", async () => {
    const h = harness();
    await stateUp(h);
    const [a] = await h.store.attemptsFor(DB);
    await h.store.updateAttempt(a?.id ?? "", { phase: "closing", error: "x" });
    h.payer.byDseq("1001").state = "closed";
    await h.seq.step(DB);
    // the original attempt (oldest) is settled by the read; no close was sent
    expect((await phasesOf(h, DB)).at(-1)).toBe("failed");
    expect(h.payer.deleteRequests).toEqual([]);
  });
});

describe("requestStop (the one writer of desired stopped)", () => {
  it("compares the release: a release recorded after the read is not stopped", async () => {
    const h = harness();
    await h.release(canaryApp(), SHA_1);
    const before = await h.store.getDesired(APP);
    await h.release(canaryApp(), SHA_2);
    const r = await h.store.requestStop(APP, {
      by: BY,
      releaseId: before?.releaseId ?? "",
    });
    expect(r).toEqual({ ok: false, reason: "release_changed" });
    expect((await h.store.getDesired(APP))?.state).toBe("running");
  });

  it("reports not_found for a workload with no row", async () => {
    const h = harness();
    expect(await h.store.requestStop(APP, { by: BY, releaseId: "x" })).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("keeps the first stopper, never clears a stored destroy, and a legacy stopped row gets a record", async () => {
    const h = harness();
    await h.release(canaryApp(), SHA_1);
    h.store.setDesiredState(APP, "stopped"); // stopped by hand: no record
    const releaseId = (await h.store.getDesired(APP))?.releaseId ?? "";
    await h.store.requestStop(APP, { by: "user:first", releaseId });
    await h.store.requestStop(APP, {
      by: "user:second",
      releaseId,
      destroyDseq: "1",
    });
    await h.store.requestStop(APP, { by: "user:third", releaseId });
    expect((await h.store.getDesired(APP))?.stop).toMatchObject({
      requestedBy: "user:first",
      destroy: { dseq: "1", by: "user:second" },
    });
  });
});
