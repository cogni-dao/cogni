// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/sequencer-test-env.test`
 * Purpose: Prove the TTL pre-pass of `NodeDeploySequencer.tick` (story.5159): a test env older than the TTL is
 *   stopped through the one writer (`requestStop`, by `system:test-env-ttl`) and its lease is then closed by the
 *   ordinary `stoppedStep`; a fresh test env and every row that is not a test env key are never touched.
 * Scope: The real sequencer over the in-memory fakes of `testing.ts`.
 * Side-effects: none
 */

import { describe, expect, it } from "vitest";
import { EdgeRouter } from "./edge";
import { DEFAULT_SEQUENCER_CONFIG, NodeDeploySequencer } from "./sequencer";
import { TEST_ENV_TTL_MS } from "./test-env";
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
  WORKLOAD_ZONE,
} from "./testing";

function harness() {
  const events: string[] = [];
  const clock = new FakeClock();
  const store = new MemoryStore(clock);
  const payer = new FakePayer(events);
  const dns = new FakeDns(events);
  const log = new MemoryLog();
  const seq = new NodeDeploySequencer({
    store,
    payer,
    edge: new EdgeRouter(dns, WORKLOAD_ZONE),
    probe: new FakeProbe(payer, dns, events),
    secrets: new MemorySecrets(),
    chain: new FakeChain(payer),
    clock,
    log,
    config: {
      ...DEFAULT_SEQUENCER_CONFIG,
      namespace: "cogni-production",
      environment: ENV,
    },
  });
  const record = (workload: string, spec = canaryApp({ name: workload })) =>
    store.recordRelease({
      nodeId: NODE_ID,
      env: ENV,
      workload,
      sourceSha: SHA_1,
      spec,
      createdBy: "test",
    });
  const stateOf = async (workload: string) =>
    (await store.getDesired({ nodeId: NODE_ID, env: ENV, workload }))?.state;
  return { clock, store, seq, log, record, stateOf };
}

describe("TTL pre-pass of tick (story.5159)", () => {
  it("stops a test env older than the TTL, by system:test-env-ttl, and nothing else", async () => {
    const h = harness();
    await h.record("canary-db", canaryDb());
    await h.record("canary"); // an ordinary app, as old as the test envs below
    await h.record("teoldold"); // te key, past the TTL
    h.clock.advance(TEST_ENV_TTL_MS - 60_000);
    await h.record("tefresh"); // te key, requested later: within the TTL
    h.clock.advance(120_000); // teoldold is now past the TTL, tefresh is not
    await h.seq.tick();
    expect(await h.stateOf("teoldold")).toBe("stopped");
    const stop = (
      await h.store.getDesired({
        nodeId: NODE_ID,
        env: ENV,
        workload: "teoldold",
      })
    )?.stop;
    expect(stop?.requestedBy).toBe("system:test-env-ttl");
    expect(h.log.lines.some((l) => l.msg === "test_env_ttl_stop")).toBe(true);
    // nothing that is not a test env key is touched, however old
    expect(await h.stateOf("canary-db")).toBe("running");
    expect(await h.stateOf("canary")).toBe("running");
    // and a fresh test env keeps running
    expect(await h.stateOf("tefresh")).toBe("running");
  });

  it("a row exactly at the TTL is not yet stopped", async () => {
    const h = harness();
    await h.record("teedgeed");
    h.clock.advance(TEST_ENV_TTL_MS);
    await h.seq.tick();
    expect(await h.stateOf("teedgeed")).toBe("running");
  });

  it("is idempotent: a second tick over an already stopped env writes nothing new", async () => {
    const h = harness();
    await h.record("teoldold");
    h.clock.advance(TEST_ENV_TTL_MS + 1);
    await h.seq.tick();
    const first = (
      await h.store.getDesired({
        nodeId: NODE_ID,
        env: ENV,
        workload: "teoldold",
      })
    )?.stop;
    await h.seq.tick();
    const second = (
      await h.store.getDesired({
        nodeId: NODE_ID,
        env: ENV,
        workload: "teoldold",
      })
    )?.stop;
    expect(second).toEqual(first);
  });
});
