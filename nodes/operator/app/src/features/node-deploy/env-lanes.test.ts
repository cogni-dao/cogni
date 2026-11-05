// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/env-lanes.test`
 * Purpose: Prove ONE sequencer process serves several envs (story.5137): the per-env config resolves the
 *   right secrets namespace and substrate host, and two REAL sequencers over one store and one payer each
 *   deploy only their own env's releases with their own OpenBao reads, edge hosts and substrate, while a
 *   fault in one env never stalls the other.
 * Side-effects: none
 */

import { COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS } from "@cogni/repo-spec";
import { describe, expect, it } from "vitest";
import type { NodeCatalogPort, NodeRuntimeSecretsPort } from "@/ports";
import { EdgeRouter, edgeHostRegexFor } from "./edge";
import {
  EnvLaneConfigError,
  EnvLaneSequencers,
  parseSubstrateHosts,
  resolveEnvLanes,
  secretsNamespaceFor,
} from "./env-lanes";
import {
  DEFAULT_SEQUENCER_CONFIG,
  NodeDeploySequencer,
  type SequencerConfig,
} from "./sequencer";
import {
  canaryApp,
  FakeChain,
  FakeClock,
  FakeDns,
  FakePayer,
  FakeProbe,
  MemoryLog,
  MemorySecrets,
  MemoryStore,
  SHA_1,
  WORKLOAD_ZONE,
} from "./testing";

const TOKS5_ID = "4b06359a-0000-4000-8000-0000000000bb";
const POLY_ID = "4b06359a-0000-4000-8000-0000000000aa";
const HOSTS = {
  "candidate-a": "cogni-candidate-a.vm.cognidao.org",
  preview: "cogni-preview.vm.cognidao.org",
  production: "cogni.vm.cognidao.org",
} as const;

const base = {
  deployEnvironment: "production",
  podNamespace: "cogni-production",
  secretsNamespace: "cogni-node-deploy-production",
  substrateHost: HOSTS.production,
};
const MULTI = {
  ...base,
  environments: "candidate-a,preview,production",
  substrateHosts: Object.entries(HOSTS)
    .map(([env, host]) => `${env}=${host}`)
    .join(","),
};

describe("resolveEnvLanes", () => {
  it("serves exactly DEPLOY_ENVIRONMENT with today's namespace and host when no list is set", () => {
    expect(resolveEnvLanes(base)).toEqual([
      {
        environment: "production",
        secretsNamespace: "cogni-node-deploy-production",
        substrateHost: HOSTS.production,
      },
    ]);
  });

  it("gives every listed env its own cogni-node-deploy-<env> namespace and substrate host", () => {
    expect(resolveEnvLanes(MULTI)).toEqual(
      (["candidate-a", "preview", "production"] as const).map((env) => ({
        environment: env,
        secretsNamespace: secretsNamespaceFor(env),
        substrateHost: HOSTS[env],
      }))
    );
  });

  it("refuses to boot on every config that would cross envs or run a node app with a half env", () => {
    const code = (input: Parameters<typeof resolveEnvLanes>[0]) => {
      try {
        resolveEnvLanes(input);
      } catch (error) {
        return error instanceof EnvLaneConfigError ? error.code : "other";
      }
      return "ok";
    };
    // the configured namespace disagrees with the env the pod serves (the admission policy reads the env from it)
    expect(
      code({ ...MULTI, secretsNamespace: "cogni-node-deploy-preview" })
    ).toBe("secrets_namespace_invalid");
    // a lane may never keep its secrets in the wallet namespace
    expect(code({ ...base, secretsNamespace: "cogni-production" })).toBe(
      "secrets_namespace_invalid"
    );
    expect(code({ ...MULTI, podNamespace: "cogni-node-deploy-preview" })).toBe(
      "secrets_namespace_invalid"
    );
    // an env without a substrate host
    expect(code({ ...MULTI, substrateHosts: `preview=${HOSTS.preview}` })).toBe(
      "substrate_host_missing"
    );
    expect(code({ ...base, substrateHost: undefined })).toBe(
      "substrate_host_missing"
    );
    expect(code({ ...MULTI, environments: "candidate-a,staging" })).toBe(
      "environment_invalid"
    );
    expect(code({ ...MULTI, environments: "preview,preview" })).toBe(
      "environment_duplicate"
    );
    expect(code({ ...MULTI, substrateHosts: "preview" })).toBe(
      "substrate_hosts_invalid"
    );
  });

  it("parses the env=host map", () => {
    expect([
      ...parseSubstrateHosts(" preview=a.example , production=b.example "),
    ]).toEqual([
      ["preview", "a.example"],
      ["production", "b.example"],
    ]);
  });
});

const DECLARED = [...COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS];
// task.5408: every node app also reads its own migration DSN from its bucket.
const BUCKET = Object.fromEntries(
  [...DECLARED, "DATABASE_MIGRATION_URL"].map((k) => [k, `v-${k}`])
);

class LaneSecrets implements NodeRuntimeSecretsPort {
  readonly reads: { env: string; slug: string }[] = [];
  async read(env: string, slug: string, keys: readonly string[]) {
    this.reads.push({ env, slug });
    return Object.fromEntries(keys.map((k) => [k, BUCKET[k] as string]));
  }
}

function lane(
  env: "candidate-a" | "preview",
  shared: {
    store: MemoryStore;
    payer: FakePayer;
    clock: FakeClock;
    events: string[];
  },
  edgeSlugs: string[]
) {
  const dns = new FakeDns(shared.events);
  const secrets = new LaneSecrets();
  const catalog: NodeCatalogPort = {
    slugs: async () => ["toks5", "poly"],
    entryFor: async (id) =>
      id === TOKS5_ID
        ? { slug: "toks5", row: { name: "toks5" } }
        : id === POLY_ID
          ? { slug: "poly", row: { name: "poly" } }
          : undefined,
  };
  const resolved = resolveEnvLanes(MULTI).find((l) => l.environment === env);
  if (!resolved) throw new Error("lane missing");
  const sequencer = new NodeDeploySequencer({
    store: shared.store,
    payer: shared.payer,
    edge: new EdgeRouter(
      dns,
      WORKLOAD_ZONE,
      edgeHostRegexFor(edgeSlugs, WORKLOAD_ZONE)
    ),
    probe: new FakeProbe(shared.payer, dns, shared.events),
    secrets: new MemorySecrets(),
    runtime: {
      secrets,
      catalog,
      substrateHost: resolved.substrateHost,
    },
    chain: new FakeChain(shared.payer),
    clock: shared.clock,
    log: new MemoryLog(),
    config: {
      ...DEFAULT_SEQUENCER_CONFIG,
      namespace: "cogni-production",
      environment: env,
      retainMs: 120_000,
    } as SequencerConfig,
  });
  return { env, sequencer, secrets, dns };
}

function fleetHarness(edge: { "candidate-a": string[]; preview: string[] }) {
  const events: string[] = [];
  const clock = new FakeClock();
  const store = new MemoryStore(clock);
  const payer = new FakePayer(events);
  const shared = { store, payer, clock, events };
  const a = lane("candidate-a", shared, edge["candidate-a"]);
  const p = lane("preview", shared, edge.preview);
  const errors: { env: string; loop: string }[] = [];
  const fleet = new EnvLaneSequencers(
    [
      { environment: "candidate-a", sequencer: a.sequencer },
      { environment: "preview", sequencer: p.sequencer },
    ],
    (env, loop) => errors.push({ env, loop })
  );
  const release = (env: "candidate-a" | "preview", host: string) =>
    store.recordRelease({
      nodeId: TOKS5_ID,
      env,
      workload: "canary",
      sourceSha: SHA_1,
      spec: canaryApp({
        bindings: [],
        secretKeys: DECLARED,
        expose: { http: { host } },
      }),
      createdBy: "test",
    });
  return { a, p, fleet, payer, store, errors, release };
}

describe("one process, every env (story.5137)", () => {
  it("each env's sequencer deploys only its own releases: own payer env, OpenBao read, edge host and substrate host", async () => {
    const h = fleetHarness({ "candidate-a": ["toks5"], preview: ["toks5"] });
    await h.release("candidate-a", "toks5-test.cognidao.org");
    await h.release("preview", "toks5-preview.cognidao.org");

    await h.fleet.tick();

    const byEnv = (env: string) =>
      h.payer.createRequests.filter((r) => r.environment === env);
    expect(byEnv("candidate-a")).toHaveLength(1);
    expect(byEnv("preview")).toHaveLength(1);
    expect(h.payer.createRequests).toHaveLength(2);
    // OpenBao bucket and namespace follow the release env, per lane
    expect(h.a.secrets.reads.length).toBeGreaterThan(0);
    expect(h.p.secrets.reads.length).toBeGreaterThan(0);
    for (const r of h.a.secrets.reads)
      expect(r).toEqual({ env: "candidate-a", slug: "toks5" });
    for (const r of h.p.secrets.reads)
      expect(r).toEqual({ env: "preview", slug: "toks5" });
    // each lane hands its own env's substrate to the node app
    const substrate = (env: string) =>
      byEnv(env)[0]?.spec.services[0]?.env?.TEMPORAL_ADDRESS;
    expect(substrate("candidate-a")).toBe(`${HOSTS["candidate-a"]}:7233`);
    expect(substrate("preview")).toBe(`${HOSTS.preview}:7233`);
    // each lane points only its own env's host
    expect([...h.a.dns.records.values()].map((r) => r.name)).toEqual([
      "toks5-test.cognidao.org",
    ]);
    expect([...h.p.dns.records.values()].map((r) => r.name)).toEqual([
      "toks5-preview.cognidao.org",
    ]);
    expect(h.errors).toEqual([]);
  });

  it("an env's edge guard comes from ITS catalog cells: a node not on the verb in preview cannot take its preview host", async () => {
    // toks5 is a node-deploy node in candidate-a only; poly in preview only
    const h = fleetHarness({ "candidate-a": ["toks5"], preview: ["poly"] });
    await h.release("candidate-a", "toks5-test.cognidao.org");
    await h.release("preview", "toks5-preview.cognidao.org");

    await h.fleet.tick();

    expect(h.payer.createRequests.map((r) => r.environment)).toEqual([
      "candidate-a",
    ]);
    expect([...h.p.dns.records.values()]).toEqual([]);
    // refused by the preview lane's own guard, before anything was paid for it
    const preview = h.store.attempts.find(
      (a) => h.store.releases.get(a.releaseId)?.env === "preview"
    );
    expect(preview?.error).toContain("edge_host_refused");
  });

  it("a sequencer never acts on another env's desired row", async () => {
    const h = fleetHarness({ "candidate-a": ["toks5"], preview: ["toks5"] });
    await h.release("preview", "toks5-preview.cognidao.org");
    const key = { nodeId: TOKS5_ID, env: "preview", workload: "canary" };

    expect(await h.a.sequencer.step(key)).toBe("idle");
    expect(h.payer.createRequests).toHaveLength(0);
    expect(await h.p.sequencer.step(key)).toBe("driven");
  });

  it("a fault in one env's pass is reported with its env and never stalls the other env", async () => {
    const h = fleetHarness({ "candidate-a": ["toks5"], preview: ["toks5"] });
    await h.release("preview", "toks5-preview.cognidao.org");
    h.store.listDesired = async (env: string) => {
      if (env === "candidate-a") throw new Error("candidate-a store down");
      return [...h.store.desired.values()].filter((d) => d.env === env);
    };

    await h.fleet.tick();
    await h.fleet.reconcileAll();

    expect(h.errors).toEqual([
      { env: "candidate-a", loop: "tick" },
      { env: "candidate-a", loop: "reconcile" },
    ]);
    // preview still deployed in the very pass candidate-a failed
    expect(h.payer.createRequests.map((r) => r.environment)).toEqual([
      "preview",
    ]);
  });
});
