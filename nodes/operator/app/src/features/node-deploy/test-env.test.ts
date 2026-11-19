// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/test-env.test`
 * Purpose: Pin the test env derivations (story.5159): the key shape, the release spec and host a test env gets
 *   (and that the sequencer's own host guard accepts them), the refusals, the catalog-derived cap, the slots a
 *   node holds (open leases count), the TTL selection and the v2 state mapping.
 * Scope: Pure derivations over the in-memory store fake; no IO.
 * Side-effects: none
 */

import { describe, expect, it } from "vitest";
import type { AttemptRow, DesiredRow, WorkloadKey } from "@/ports";
import { isTestEnvKey, isTestEnvSpec } from "@/ports";
import { hostOwnedBy, siblingLabel } from "./edge";
import {
  expiredTestEnvs,
  MAX_TEST_ENVS_PER_NODE,
  newTestEnvKey,
  TEST_ENV_LABEL_ENV,
  TEST_ENV_TTL_MS,
  TestEnvRefusal,
  testEnvHost,
  testEnvSlots,
  testEnvSpec,
  testEnvState,
} from "./test-env";
import {
  canaryApp,
  FakeClock,
  MemoryStore,
  NODE_ID,
  WORKLOAD_ZONE,
} from "./testing";

const ZONE = WORKLOAD_ZONE;
const KEY = "teqwkzmx";
const MIN = 60_000;

/** The node's resolved `app` spec as `resolveWorkloadDeclaration` returns it for candidate-a. */
const app = (over: Record<string, unknown> = {}) =>
  canaryApp({
    name: "app",
    bindings: [],
    expose: { http: { host: "red-test.cognidao.org" } },
    ...over,
  });

describe("test env key and host", () => {
  it("a key is `te` + 6 letters, and only that shape", () => {
    expect(isTestEnvKey(KEY)).toBe(true);
    for (const bad of [
      "app",
      "main",
      "canary",
      "te-qwkzmx",
      "teqwkzm",
      "teqwkzmxy",
      "teqwkz1x",
      "TEQWKZMX",
      "xteqwkzmx",
    ])
      expect(isTestEnvKey(bad), bad).toBe(false);
  });
  it("newTestEnvKey draws only letters and always matches the key shape", () => {
    let i = 0;
    expect(newTestEnvKey(() => i++)).toBe("teabcdef");
    for (let n = 0; n < 200; n++)
      expect(isTestEnvKey(newTestEnvKey())).toBe(true);
  });
  it("the host is <slug>-<key>-test.<zone> on candidate-a", () => {
    expect(testEnvHost("red", KEY, ZONE)).toBe(`red-${KEY}-test.cognidao.org`);
    expect(testEnvHost("spawny-boi", KEY, ZONE)).toBe(
      `spawny-boi-${KEY}-test.cognidao.org`
    );
  });
});

describe("testEnvSpec", () => {
  it("is the app spec under the key, on its own sibling host, with an optional label", () => {
    const spec = testEnvSpec(app(), {
      key: KEY,
      slug: "red",
      binding: ZONE,
      label: "pr-42",
    });
    expect(spec.name).toBe(KEY);
    expect(spec.expose).toEqual({
      http: { host: `red-${KEY}-test.cognidao.org` },
    });
    expect(spec.env[TEST_ENV_LABEL_ENV]).toBe("pr-42");
    // the marker that makes the row exactly a test env (not just a te-shaped name)
    expect(spec.env.COGNI_TEST_ENV).toBe("1");
    expect(isTestEnvSpec(spec)).toBe(true);
    expect(isTestEnvSpec({ ...spec, env: {} })).toBe(false);
    expect(isTestEnvSpec({ name: "app", env: { COGNI_TEST_ENV: "1" } })).toBe(
      false
    );
    // everything else is the app's: image, port, health, resources
    expect(spec.image).toBe(app().image);
    expect(spec.port).toBe(app().port);
    expect(spec.health).toEqual(app().health);
    // no label, no label env
    expect(
      testEnvSpec(app(), { key: KEY, slug: "red", binding: ZONE }).env
    ).not.toHaveProperty(TEST_ENV_LABEL_ENV);
  });
  it("its host passes the SAME guard the sequencer applies, and is never the node's main host", () => {
    const spec = testEnvSpec(app(), { key: KEY, slug: "red", binding: ZONE });
    const host = (spec.expose as { http: { host: string } }).http.host;
    expect(hostOwnedBy(ZONE, host, "candidate-a", "red")).toBe(false); // not the node's own host
    const label = siblingLabel({
      binding: ZONE,
      host,
      env: "candidate-a",
      slug: "red",
      workload: KEY,
      worker: false,
    });
    expect(label).toBe(KEY);
    expect(hostOwnedBy(ZONE, host, "candidate-a", "red", label)).toBe(true);
    // and it is no other node's host
    expect(hostOwnedBy(ZONE, host, "candidate-a", "toks5", KEY)).toBe(false);
  });
  it.each([
    [
      "state bindings",
      { bindings: [{ env: "DATABASE_URL", workload: "x-db" }] },
    ],
    ["companions", { companions: [{ name: "side", port: 1 }] }],
    ["a worker", { runtimeProfile: "worker" }],
    ["a state workload", { kind: "state" }],
    ["no public host", { expose: { tcp: { global: true } } }],
  ])("refuses to copy an app with %s", (_why, over) => {
    expect(() =>
      testEnvSpec(app(over), { key: KEY, slug: "red", binding: ZONE })
    ).toThrow(expect.objectContaining({ code: "test_env_unsupported" }));
  });
  it("refuses a non-key name and the operator node", () => {
    expect(() =>
      testEnvSpec(app(), { key: "canary", slug: "red", binding: ZONE })
    ).toThrow(TestEnvRefusal);
    expect(() =>
      testEnvSpec(app(), { key: KEY, slug: "operator", binding: ZONE })
    ).toThrow(expect.objectContaining({ code: "test_env_node_refused" }));
  });
});

describe("cap", () => {
  it("a node may hold 5 test envs", () => {
    expect(MAX_TEST_ENVS_PER_NODE).toBe(5);
  });
});

describe("slots, TTL and state", () => {
  const clock = new FakeClock();
  const att = (phase: AttemptRow["phase"]): AttemptRow =>
    ({ phase }) as AttemptRow;
  function seeded() {
    const store = new MemoryStore(clock);
    const put = async (
      workload: string,
      state: "running" | "stopped",
      ageMin: number,
      attempts: AttemptRow["phase"][] = [],
      nodeId = NODE_ID,
      marked = false
    ) => {
      const key: WorkloadKey = { nodeId, env: "candidate-a", workload };
      const { release } = await store.recordRelease({
        ...key,
        sourceSha: "a".repeat(40),
        spec: app({
          name: workload,
          env: marked ? { COGNI_TEST_ENV: "1" } : {},
        }),
        createdBy: "t",
      });
      const row = store.desired.get(
        `${nodeId}/candidate-a/${workload}`
      ) as DesiredRow;
      store.desired.set(`${nodeId}/candidate-a/${workload}`, {
        ...row,
        state,
        updatedAt: new Date(clock.now() - ageMin * MIN),
      });
      for (const phase of attempts)
        store.attempts.push({
          ...att(phase),
          releaseId: release.id,
        } as AttemptRow);
    };
    return { store, put };
  }

  it("a node's slots are its running te rows plus stopped ones with an open lease, oldest first", async () => {
    const { store, put } = seeded();
    await put("teaaaaaa", "running", 10);
    await put("tebbbbbb", "stopped", 20, ["active"]); // closing: lease still open
    await put("teccccc", "running", 30); // not a key (5 letters)
    await put("teddddd1", "running", 30); // not a key (digit)
    await put("tedddddd", "stopped", 40, ["retired"]); // closed: no slot
    await put("teeeeeee", "stopped", 50); // never leased: no slot
    await put("app", "running", 99); // not a test env
    await put(
      "tezzzzzz",
      "running",
      5,
      [],
      "00000000-0000-4000-8000-000000000009"
    ); // another node
    const slots = await testEnvSlots(store, NODE_ID);
    expect(slots.map((s) => s.workload)).toEqual(["tebbbbbb", "teaaaaaa"]);
  });

  it("expiredTestEnvs selects only running te rows older than the TTL, never any other row", async () => {
    const { store, put } = seeded();
    const old = TEST_ENV_TTL_MS / MIN + 1;
    await put("teoldold", "running", old, [], NODE_ID, true);
    await put("tefresh", "running", 1, [], NODE_ID, true);
    await put(
      "tefreshx",
      "running",
      TEST_ENV_TTL_MS / MIN - 1,
      [],
      NODE_ID,
      true
    );
    await put("testopps", "stopped", old, [], NODE_ID, true);
    await put("template", "running", old * 10); // te-shaped real word, no marker
    await put("app", "running", old * 10);
    await put("canary", "running", old * 10);
    await put("canary-db", "running", old * 10);
    const rows = await store.listDesired("candidate-a");
    expect(
      (await expiredTestEnvs(store, rows, clock.now())).map((d) => d.workload)
    ).toEqual(["teoldold"]);
    expect(await expiredTestEnvs(store, [], clock.now())).toEqual([]);
  });

  it("maps the release view to the v2 states", () => {
    const s = (
      desiredState: "running" | "stopped",
      releaseState: Parameters<typeof testEnvState>[0]["releaseState"],
      attempts: AttemptRow["phase"][] = []
    ) =>
      testEnvState({
        desiredState,
        releaseState,
        attempts: attempts.map(att),
      });
    expect(s("running", "queued")).toBe("requested");
    expect(s("running", "deploying", ["proving"])).toBe("deploying");
    expect(s("running", "failed", ["failed"])).toBe("failed");
    expect(s("running", "parked", ["failed"])).toBe("failed");
    expect(s("running", "active", ["active"])).toBe("ready");
    expect(s("stopped", "active", ["active"])).toBe("closing");
    expect(s("stopped", "active", ["closing"])).toBe("closing");
    expect(s("stopped", "active", ["retired"])).toBe("closed");
    expect(s("stopped", "queued")).toBe("closed");
  });
});
