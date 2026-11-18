// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/instance-directory.test`
 * Purpose: Pin the instance directory (story.5159 step 1): which running, proven workloads of a node are
 *   listed as instances, what host each serves from, and which are absent (closed, unproven, foreign host).
 * Scope: Pure projection over the in-memory store fake; no IO.
 * Side-effects: none
 */

import { describe, expect, it } from "vitest";
import { DeployInstancesReadSchema } from "@/contracts/deploy.instances.v1.contract";
import type { AttemptRow, NodeWorkloadSpec, WorkloadKey } from "@/ports";
import {
  buildInstanceDirectory,
  instanceOfWorkload,
} from "./instance-directory";
import {
  canaryApp,
  FakeClock,
  MemoryStore,
  NODE_ID,
  SHA_1,
  SHA_2,
  WORKLOAD_ZONE,
} from "./testing";

const OTHER_NODE_ID = "f66b260b-4633-41e2-8711-b7c1b8449cc1";
const ENV = "candidate-a";
const REL = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

const attempt = (
  releaseId: string,
  phase: AttemptRow["phase"],
  n = 1
): AttemptRow => ({
  id: `a-${releaseId}-${n}`,
  releaseId,
  attempt: n,
  cogniKey: `k-${releaseId}-${n}`,
  externalName: undefined,
  provider: undefined,
  endpoints: [],
  phase,
  error: undefined,
  unhealthySince: undefined,
  createdAt: new Date(0),
  leasedAt: undefined,
  updatedAt: new Date(0),
  steps: [],
});

interface Seed {
  readonly key: WorkloadKey;
  readonly releaseId: string;
  readonly sha?: string;
  readonly host: string;
  readonly phase: AttemptRow["phase"] | undefined;
  readonly state?: "running" | "stopped";
  readonly spec?: Partial<NodeWorkloadSpec>;
}

function seeded(seeds: readonly Seed[]): MemoryStore {
  const store = new MemoryStore(new FakeClock());
  for (const s of seeds) {
    const spec = canaryApp({
      name: s.key.workload,
      expose: { http: { host: s.host } },
      ...s.spec,
    });
    store.releases.set(s.releaseId, {
      id: s.releaseId,
      ...s.key,
      sourceSha: s.sha ?? SHA_1,
      spec,
      createdBy: "user:u1",
      createdAt: new Date(0),
    });
    store.desired.set(`${s.key.nodeId}/${s.key.env}/${s.key.workload}`, {
      ...s.key,
      state: s.state ?? "running",
      releaseId: s.releaseId,
      updatedAt: new Date(0),
    });
    if (s.phase) store.attempts.push(attempt(s.releaseId, s.phase));
  }
  return store;
}

const key = (workload: string, nodeId = NODE_ID): WorkloadKey => ({
  nodeId,
  env: ENV,
  workload,
});

const directory = (store: MemoryStore, slug = "red") =>
  buildInstanceDirectory({
    store,
    nodeId: NODE_ID,
    slug,
    env: ENV,
    binding: WORKLOAD_ZONE,
  });

describe("instanceOfWorkload", () => {
  it("names `app` main and any other workload by its own name", () => {
    expect(instanceOfWorkload("app")).toBe("main");
    expect(instanceOfWorkload(undefined)).toBe("main");
    expect(instanceOfWorkload("canary")).toBe("canary");
    expect(instanceOfWorkload("pr-401")).toBe("pr-401");
  });
});

describe("buildInstanceDirectory", () => {
  it("lists the proven main and canary instances with their own hosts", async () => {
    const store = seeded([
      {
        key: key("app"),
        releaseId: REL(1),
        sha: SHA_1,
        host: "red-test.cognidao.org",
        phase: "active",
      },
      {
        key: key("canary"),
        releaseId: REL(2),
        sha: SHA_2,
        host: "red-canary-test.cognidao.org",
        phase: "active",
      },
    ]);
    const out = await directory(store);
    expect(out).toEqual([
      {
        instance: "canary",
        workload: "canary",
        host: "red-canary-test.cognidao.org",
        releaseId: REL(2),
        sourceSha: SHA_2,
      },
      {
        instance: "main",
        workload: "app",
        host: "red-test.cognidao.org",
        releaseId: REL(1),
        sourceSha: SHA_1,
      },
    ]);
    expect(
      DeployInstancesReadSchema.safeParse({
        nodeId: NODE_ID,
        env: ENV,
        asOf: new Date(0).toISOString(),
        instances: out,
      }).success
    ).toBe(true);
  });

  it("serves the host of the release whose attempt is active, not the newer desired release", async () => {
    const store = seeded([
      {
        key: key("canary"),
        releaseId: REL(2),
        host: "red-canary-test.cognidao.org",
        phase: "active",
      },
    ]);
    // a newer release is desired and still deploying; the live lease belongs to REL(2)
    const live = store.releases.get(REL(2));
    if (!live) throw new Error("fixture release missing");
    store.releases.set(REL(3), { ...live, id: REL(3), sourceSha: SHA_2 });
    store.desired.set(`${NODE_ID}/${ENV}/canary`, {
      ...key("canary"),
      state: "running",
      releaseId: REL(3),
      updatedAt: new Date(0),
    });
    store.attempts.push(attempt(REL(3), "proving"));
    const [only] = await directory(store);
    expect(only?.releaseId).toBe(REL(2));
    expect(only?.sourceSha).toBe(SHA_1);
  });

  it("omits a stopped workload, an unproven one and one with no attempt (closed or never served)", async () => {
    const store = seeded([
      {
        key: key("canary"),
        releaseId: REL(1),
        host: "red-canary-test.cognidao.org",
        phase: "active",
        state: "stopped",
      },
      {
        key: key("canaryb"),
        releaseId: REL(2),
        host: "red-canaryb-test.cognidao.org",
        phase: "proven",
      },
      {
        key: key("canaryc"),
        releaseId: REL(3),
        host: "red-canaryc-test.cognidao.org",
        phase: undefined,
      },
      {
        key: key("canaryd"),
        releaseId: REL(4),
        host: "red-canaryd-test.cognidao.org",
        phase: "retired",
      },
    ]);
    expect(await directory(store)).toEqual([]);
  });

  it("lists only the asked node", async () => {
    const store = seeded([
      {
        key: key("app", OTHER_NODE_ID),
        releaseId: REL(1),
        host: "toks5-test.cognidao.org",
        phase: "active",
      },
    ]);
    expect(await directory(store)).toEqual([]);
  });

  it("drops a release whose host the node may not claim", async () => {
    const store = seeded([
      {
        key: key("canary"),
        releaseId: REL(1),
        host: "toks5-canary-test.cognidao.org",
        phase: "active",
      },
      {
        key: key("app"),
        releaseId: REL(2),
        host: "toks5-test.cognidao.org",
        phase: "active",
      },
    ]);
    expect(await directory(store)).toEqual([]);
  });

  it("never lists a worker workload, nor a non-app workload named main", async () => {
    const store = seeded([
      {
        key: key("sandbox"),
        releaseId: REL(1),
        host: "red-sandbox-test.cognidao.org",
        phase: "active",
        spec: { runtimeProfile: "worker" } as Partial<NodeWorkloadSpec>,
      },
      {
        key: key("main"),
        releaseId: REL(2),
        host: "red-main-test.cognidao.org",
        phase: "active",
      },
    ]);
    expect(await directory(store)).toEqual([]);
  });
});
