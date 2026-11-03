// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/worker-workload.test`
 * Purpose: Prove a node's sibling WORKER workload (red's `sandbox`, task.5272) is declared, lowered and
 *   deployed as its own routed lease at `<slug>-<workload>` that receives ONLY its own declared secrets:
 *   no node-app profile, no database credential, no substrate topology, no DB CA wrapper.
 * Side-effects: filesystem read of the root `.cogni/repo-spec.yaml`
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS } from "@cogni/repo-spec";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

import type { NodeCatalogPort, NodeRuntimeSecretsPort } from "@/ports";
import { NodeRuntimeSecretsError } from "@/ports";

import { resolveWorkloadDeclaration } from "./declarations";
import { EdgeRouter, edgeHostRegexFor } from "./edge";
import { workerEnv } from "./node-app-env";
import {
  DEFAULT_SEQUENCER_CONFIG,
  NodeDeploySequencer,
  type SequencerConfig,
} from "./sequencer";
import {
  canaryApp,
  ENV,
  FakeChain,
  FakeClock,
  FakeDns,
  FakePayer,
  FakeProbe,
  MemoryLog,
  MemorySecrets,
  MemoryStore,
  SHA_1,
} from "./testing";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../../../../../..");
const RED_ID = "921b1d1d-4ded-4a6d-b3f1-f7d6affa406a";
const TOKEN = "t".repeat(40);
const SANDBOX_IMAGE = `ghcr.io/cogni-dao/red-sandbox@sha256:${"d".repeat(64)}`;

const service = (over: Record<string, unknown>) => ({
  artifact: { name: "x", context: ".", dockerfile: "Dockerfile" },
  port: 3200,
  visibility: "public",
  bindings: {},
  bind_host: "0.0.0.0",
  resources: { cpu_units: 1, memory_mi: 512, storage_mi: 1024 },
  ...over,
});

/** The repo-spec of a node shaped like red: one node-app service plus one profile-less sandbox. */
function redSpec(
  sandbox: Record<string, unknown> = {},
  app: Record<string, unknown> = { runtime_profile: "cogni-node-app-v1" }
): string {
  const root = parse(
    readFileSync(path.join(ROOT, ".cogni/repo-spec.yaml"), "utf8")
  ) as Record<string, unknown>;
  return stringify({
    ...root,
    node_id: RED_ID,
    deployment: {
      services: [
        service({ name: "app", ...app }),
        service({
          name: "sandbox",
          port: 8080,
          visibility: "private",
          secret_refs: [{ key: "SANDBOX_EXECD_TOKEN" }],
          ...sandbox,
        }),
      ],
    },
  });
}

const manifest = (name: string, port: number, host: string, image: string) => ({
  path: `.cogni/workloads/${name}.yaml`,
  text: `apiVersion: score.dev/v1b1
metadata:
  name: ${name}
  annotations:
    cogni.dev/exclusive: "false"
containers:
  ${name}:
    image: ${image}
    resources:
      requests: {cpu: "1", memory: 1024Mi}
    readinessProbe:
      httpGet: {path: /readyz, port: ${port}}
service:
  ports:
    web: {port: 80, targetPort: ${port}}
resources:
  web:
    type: route
    params: {host: ${host}, path: /, port: 80}
`,
});

const SANDBOX = manifest(
  "sandbox",
  8080,
  "red-sandbox.cognidao.org",
  SANDBOX_IMAGE
);
const APP = manifest("app", 3200, "red.cognidao.org", SANDBOX_IMAGE);

const resolve = (
  over: Partial<Parameters<typeof resolveWorkloadDeclaration>[0]> = {}
) =>
  resolveWorkloadDeclaration({
    repoSpecText: redSpec(),
    manifests: [APP, SANDBOX],
    nodeId: RED_ID,
    env: "production",
    workload: "sandbox",
    ...over,
  });

describe("declaring a worker workload", () => {
  it("lowers to a worker: its own secret_refs only, on its own host that follows the environment", () => {
    const w = resolve({ env: "candidate-a" });
    expect(w).toMatchObject({
      kind: "app",
      runtimeProfile: "worker",
      port: 8080,
      image: SANDBOX_IMAGE,
      secretKeys: ["SANDBOX_EXECD_TOKEN"],
      expose: { http: { host: "red-sandbox-test.cognidao.org" } },
    });
    expect(resolve({ env: "preview" }).expose).toEqual({
      http: { host: "red-sandbox-preview.cognidao.org" },
    });
  });

  it("the node app of the same repo-spec still gets the node-app profile keys and no worker marker", () => {
    const w = resolve({ workload: "app" });
    expect(w.runtimeProfile).toBeUndefined();
    expect(w.secretKeys).toEqual(
      expect.arrayContaining([...COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS])
    );
    expect(w.secretKeys).not.toContain("SANDBOX_EXECD_TOKEN");
  });

  it("fails safe: with no distinct node-app service, a profile-less service stays the node app", () => {
    const w = resolve({
      repoSpecText: redSpec({}, { runtime_profile: undefined }),
      workload: "sandbox",
    });
    expect(w.runtimeProfile).toBeUndefined();
  });

  it("refuses a worker that declares an operator or fleet credential", () => {
    expect(() =>
      resolve({
        repoSpecText: redSpec({
          secret_refs: [{ key: "AKASH_CONSOLE_API_KEY" }],
        }),
      })
    ).toThrow(expect.objectContaining({ code: "secret_ref_refused" }));
  });
});

describe("workerEnv", () => {
  it("is exactly host, port, env, sha and the declared secrets; never a profile or substrate key", () => {
    const env = workerEnv({
      env: "production",
      sourceSha: SHA_1,
      port: 8080,
      secretKeys: ["SANDBOX_EXECD_TOKEN"],
      secrets: { SANDBOX_EXECD_TOKEN: TOKEN, DATABASE_URL: "postgres://x" },
    });
    expect(env).toEqual({
      HOST: "0.0.0.0",
      PORT: "8080",
      DEPLOY_ENVIRONMENT: "production",
      COGNI_REPO_SHA: SHA_1,
      SANDBOX_EXECD_TOKEN: TOKEN,
    });
  });

  it("fails closed on a missing or denylisted key", () => {
    const base = { env: "production", sourceSha: SHA_1, port: 8080 };
    expect(() =>
      workerEnv({ ...base, secretKeys: ["SANDBOX_EXECD_TOKEN"], secrets: {} })
    ).toThrow(/missing or not injectable: SANDBOX_EXECD_TOKEN/);
    expect(() =>
      workerEnv({
        ...base,
        secretKeys: ["AKASH_CONSOLE_API_KEY"],
        secrets: { AKASH_CONSOLE_API_KEY: "x" },
      })
    ).toThrow(/operator\/fleet credentials/);
  });
});

class Bucket implements NodeRuntimeSecretsPort {
  bucket: Record<string, string> = {
    SANDBOX_EXECD_TOKEN: TOKEN,
    DATABASE_URL: "postgres://must-not-leak",
    AUTH_SECRET: "must-not-leak",
  };
  readonly reads: string[][] = [];
  async read(_env: string, _slug: string, keys: readonly string[]) {
    this.reads.push([...keys]);
    const missing = keys.filter((k) => !this.bucket[k]);
    if (missing.length > 0)
      throw new NodeRuntimeSecretsError("missing_keys", "missing", missing);
    return Object.fromEntries(keys.map((k) => [k, this.bucket[k] as string]));
  }
}

class Catalog implements NodeCatalogPort {
  constructor(
    private readonly slug: string,
    private readonly all: readonly string[]
  ) {}
  async slugs() {
    return this.all;
  }
  async entryFor(nodeId: string) {
    return nodeId === RED_ID
      ? { slug: this.slug, row: { name: this.slug } }
      : undefined;
  }
}

function harness(slug = "red", all: readonly string[] = ["red", "poly"]) {
  const events: string[] = [];
  const clock = new FakeClock();
  const store = new MemoryStore(clock);
  const payer = new FakePayer(events);
  const dns = new FakeDns(events);
  const bucket = new Bucket();
  const seq = new NodeDeploySequencer({
    store,
    payer,
    edge: new EdgeRouter(dns, edgeHostRegexFor(all)),
    probe: new FakeProbe(payer, dns, events),
    secrets: new MemorySecrets(),
    runtime: {
      secrets: bucket,
      catalog: new Catalog(slug, all),
      substrateHost: "cogni.vm.cognidao.org",
    },
    chain: new FakeChain(payer),
    clock,
    log: new MemoryLog(),
    config: {
      ...DEFAULT_SEQUENCER_CONFIG,
      namespace: "cogni-production",
      environment: ENV,
      retainMs: 120_000,
    } as SequencerConfig,
  });
  return { store, payer, bucket, seq };
}

async function release(
  h: ReturnType<typeof harness>,
  host: string,
  kind: "worker" | "app" = "worker",
  name = "sandbox"
) {
  await h.store.recordRelease({
    nodeId: RED_ID,
    env: ENV,
    workload: name,
    sourceSha: SHA_1,
    spec: canaryApp({
      name,
      image: SANDBOX_IMAGE,
      port: 8080,
      command: undefined,
      bindings: [],
      secretKeys: ["SANDBOX_EXECD_TOKEN"],
      ...(kind === "worker" ? { runtimeProfile: "worker" as const } : {}),
      expose: { http: { host } },
    }),
    createdBy: "test",
  });
  return h.seq.step({ nodeId: RED_ID, env: ENV, workload: name });
}

describe("deploying a worker through the real sequencer", () => {
  it("creates it on red's sandbox host with only its own secret, no profile env, no DB CA wrapper", async () => {
    const h = harness();
    expect(await release(h, "red-sandbox.cognidao.org")).toBe("driven");
    expect(h.bucket.reads.at(-1)).toEqual(["SANDBOX_EXECD_TOKEN"]);
    const svc = h.payer.createRequests[0]?.spec.services[0];
    expect(svc?.env).toMatchObject({
      HOST: "0.0.0.0",
      PORT: "8080",
      COGNI_REPO_SHA: SHA_1,
      SANDBOX_EXECD_TOKEN: TOKEN,
    });
    for (const leaked of [
      "DATABASE_URL",
      "AUTH_SECRET",
      "COGNI_NODE_ID",
      "NODE_NAME",
      "TEMPORAL_ADDRESS",
    ])
      expect(svc?.env, leaked).not.toHaveProperty(leaked);
    // no database CA trust wrapper: the image's own entrypoint runs
    expect(svc?.command).toBeUndefined();
  });

  it("refuses a host that is neither the node's own nor <slug>-<workload>, before any paid create", async () => {
    const h = harness();
    await release(h, "red-other.cognidao.org");
    expect(h.payer.createRequests).toHaveLength(0);
    const attempts = await h.store.attemptsFor({
      nodeId: RED_ID,
      env: ENV,
      workload: "sandbox",
    });
    expect(attempts[0]?.error).toMatch(/edge_host_refused/);
  });

  it("does not deliver a missing declared secret: waits, no create", async () => {
    const h = harness();
    delete h.bucket.bucket.SANDBOX_EXECD_TOKEN;
    await release(h, "red-sandbox.cognidao.org");
    expect(h.payer.createRequests).toHaveLength(0);
  });
});

describe("a worker host cannot collide with another host (WORKER_HOST_IS_UNAMBIGUOUS)", () => {
  const refused = async (
    h: ReturnType<typeof harness>,
    name: string,
    host: string,
    kind: "worker" | "app" = "worker"
  ) => {
    await release(h, host, kind, name);
    expect(h.payer.createRequests).toHaveLength(0);
    const attempts = await h.store.attemptsFor({
      nodeId: RED_ID,
      env: ENV,
      workload: name,
    });
    expect(attempts[0]?.error).toMatch(/edge_host_refused/);
  };

  it("red + sandbox is refused when a catalog node is named red-sandbox", async () => {
    await refused(
      harness("red", ["red", "red-sandbox"]),
      "sandbox",
      "red-sandbox.cognidao.org"
    );
  });

  it("node + template is refused when node-template is in the catalog", async () => {
    await refused(
      harness("node", ["node", "node-template"]),
      "template",
      "node-template.cognidao.org"
    );
  });

  it("poly + test in production is refused: poly-test is poly's own candidate-a host", async () => {
    await refused(
      harness("poly", ["poly", "red"]),
      "test",
      "poly-test.cognidao.org"
    );
  });

  it("a hyphenated or environment-word worker name is refused", async () => {
    await refused(
      harness("red", ["red"]),
      "sandbox-test",
      "red-sandbox-test.cognidao.org"
    );
    await refused(
      harness("red", ["red"]),
      "preview",
      "red-preview.cognidao.org"
    );
  });

  it("a workload that is not a lowered worker never gets a <slug>-<workload> host", async () => {
    await refused(
      harness("red", ["red"]),
      "sandbox",
      "red-sandbox.cognidao.org",
      "app"
    );
  });
});
