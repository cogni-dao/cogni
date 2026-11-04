// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/sequencer-node-app.test`
 * Purpose: Prove a node APP deployed by the REAL sequencer gets the Crossplane lane's runtime env with
 *   OpenBao as custodian, that nothing is paid while that env cannot be resolved, and that placement
 *   (interim provider allowlist + catalog countries) rides the create (task.5405).
 * Side-effects: none
 */

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { type ClientRequest, IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { Socket } from "node:net";
import {
  COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS,
  NODE_BUNDLE_ARTIFACT_TYPE,
  NODE_BUNDLE_PAYLOAD_FILE,
  NODE_BUNDLE_PAYLOAD_MEDIA_TYPE,
  type NodeWorkloadSpec,
  nodeServiceSpecSchema,
} from "@cogni/repo-spec";
import { buildTestRepoSpec } from "@cogni/repo-spec/testing";
import { decodeJwt } from "jose";
import { describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { HttpProbe } from "@/adapters/server/node-deploy/http-probe.adapter";
import { GhcrBuiltImageResolver } from "@/adapters/server/oci/ghcr-built-image.adapter";
import type {
  BuiltImageResolverPort,
  NodeCatalogPort,
  NodeRuntimeSecretsPort,
  WorkloadKey,
} from "@/ports";
import { BuiltImageRegistryError, NodeRuntimeSecretsError } from "@/ports";
import { selectReleaseBundle } from "./artifact-selection";
import { DeclarationError, resolveWorkloadDeclaration } from "./declarations";

import { EdgeRouter, edgeHostRegexFor } from "./edge";
import { nodeAppEnv } from "./node-app-env";
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
  NODE_ID as OPERATOR_NODE_ID,
  PUBLIC_HOST,
  SHA_1,
} from "./testing";

const POLY_ID = "4b06359a-0000-4000-8000-0000000000aa";
const SUBSTRATE = "cogni.vm.cognidao.org";
const POLY_HOST = "poly.cognidao.org";
const TOKS_ID = "4b06359a-0000-4000-8000-0000000000bb";
const ALLOWED = [
  "akash16yr3wxt97ae045a06kr3ycde9srcgpg8syjxxm",
  "akash1v0f04wr3tkh9uf43q9eqfd0whpfeu8qevlq99h",
];

const PROFILE_BUCKET: Record<string, string> = Object.fromEntries(
  COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS.map((k) => [k, `value-of-${k}`])
);

/** Fleet-inherited keys that sit in a node's bucket but are not in its declared secret_refs. */
const INHERITED = {
  GH_WEBHOOK_SECRET: "inherited-wh",
  POSTHOG_API_KEY: "inherited-ph",
  TAVILY_API_KEY: "inherited-tv",
};
const DECLARED = [
  ...COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS,
  "PAPER_ENFORCE_MODE",
];

class FakeRuntimeSecrets implements NodeRuntimeSecretsPort {
  /** The node's OpenBao bucket: declared keys AND fleet-inherited keys that are NOT declared. */
  bucket: Record<string, string> = {
    ...PROFILE_BUCKET,
    PAPER_ENFORCE_MODE: "true",
    ...INHERITED,
  };
  down = false;
  readonly reads: { env: string; slug: string; keys: string[] }[] = [];
  /** Like the real port: EXACTLY the requested keys, or a typed failure naming the missing ones. */
  async read(env: string, slug: string, keys: readonly string[]) {
    this.reads.push({ env, slug, keys: [...keys] });
    if (this.down) throw new NodeRuntimeSecretsError("unavailable", "login");
    const missing = keys.filter((k) => !this.bucket[k]);
    if (missing.length > 0)
      throw new NodeRuntimeSecretsError(
        "missing_keys",
        `required keys missing: ${missing.join(", ")}`,
        missing
      );
    return Object.fromEntries(keys.map((k) => [k, this.bucket[k] as string]));
  }
}

/** The registry: `sha-<sha>` tags that node CI has published, each with its digest. */
class FakeImages implements BuiltImageResolverPort {
  checkImageManifests?: NonNullable<
    BuiltImageResolverPort["checkImageManifests"]
  >;
  resolveArtifactBundle?: NonNullable<
    BuiltImageResolverPort["resolveArtifactBundle"]
  >;
  readonly published = new Map<string, string>();
  readonly calls: { imageRepository: string; sourceSha: string }[] = [];
  down = false;
  async resolveBuiltImage(input: {
    imageRepository: string;
    sourceSha: string;
  }): Promise<string | null> {
    this.calls.push(input);
    if (this.down) throw new BuiltImageRegistryError("ghcr 503");
    return this.published.get(input.sourceSha) ?? null;
  }
}

class FakeCatalog implements NodeCatalogPort {
  rows = new Map<string, { slug: string; row: unknown }>([
    [
      POLY_ID,
      {
        slug: "poly",
        row: {
          name: "poly",
          required_placement_countries: {
            production: ["FI", "NL", "PT", "UA"],
          },
        },
      },
    ],
    [OPERATOR_NODE_ID, { slug: "operator", row: { name: "operator" } }],
  ]);
  async slugs() {
    return [...this.rows.values()].map((r) => r.slug);
  }
  async entryFor(nodeId: string) {
    return this.rows.get(nodeId);
  }
}

function harness(cfg: Partial<SequencerConfig> = {}) {
  const events: string[] = [];
  const clock = new FakeClock();
  const store = new MemoryStore(clock);
  const payer = new FakePayer(events);
  const dns = new FakeDns(events);
  const probe = new FakeProbe(payer, dns, events);
  const secrets = new MemorySecrets();
  const runtimeSecrets = new FakeRuntimeSecrets();
  const catalog = new FakeCatalog();
  const images = new FakeImages();
  const log = new MemoryLog();
  const seq = new NodeDeploySequencer({
    store,
    payer,
    edge: new EdgeRouter(dns, edgeHostRegexFor(["poly", "toks5"])),
    probe,
    secrets,
    runtime: { secrets: runtimeSecrets, catalog, substrateHost: SUBSTRATE },
    images,
    chain: new FakeChain(payer),
    clock,
    log,
    config: {
      ...DEFAULT_SEQUENCER_CONFIG,
      namespace: "cogni-production",
      environment: ENV,
      retainMs: 120_000,
      appProviders: ALLOWED,
      ...cfg,
    } as SequencerConfig,
  });
  const key = (nodeId: string, workload: string): WorkloadKey => ({
    nodeId,
    env: ENV,
    workload,
  });
  return {
    store,
    payer,
    runtimeSecrets,
    catalog,
    images,
    clock,
    log,
    seq,
    key,
    probe,
    dns,
    events,
  };
}

type H = ReturnType<typeof harness>;

async function stateUp(h: H, nodeId: string) {
  await h.store.recordRelease({
    nodeId,
    env: ENV,
    workload: "canary-db",
    sourceSha: SHA_1,
    spec: canaryDb(),
    createdBy: "test",
  });
  expect(await h.seq.step(h.key(nodeId, "canary-db"))).toBe("driven");
}

async function releaseApp(h: H, nodeId: string) {
  await h.store.recordRelease({
    nodeId,
    env: ENV,
    workload: "canary",
    sourceSha: SHA_1,
    spec: canaryApp({
      secretKeys: DECLARED,
      expose: {
        http: { host: nodeId === POLY_ID ? POLY_HOST : PUBLIC_HOST },
      },
    }),
    createdBy: "test",
  });
  return h.seq.step(h.key(nodeId, "canary"));
}

const appCreates = (h: H) =>
  h.payer.createRequests.filter((r) => r.spec.name === "canary");

describe("node app runtime env (task.5405)", () => {
  it("a non-operator node app gets the composition env, OpenBao-sourced; a state binding overrides the bucket (CD2)", async () => {
    const h = harness();
    await stateUp(h, POLY_ID);
    expect(await releaseApp(h, POLY_ID)).toBe("driven");
    const req = appCreates(h)[0];
    const env = req?.spec.services[0]?.env ?? {};
    const expected = nodeAppEnv({
      env: ENV,
      slug: "poly",
      nodeId: POLY_ID,
      sourceSha: SHA_1,
      publicHost: POLY_HOST,
      port: 8080,
      substrateHost: SUBSTRATE,
      secrets: PROFILE_BUCKET,
      boundEnvNames: ["DATABASE_URL"],
    });
    // every composition key is present with the composition's value, except what a binding supplies
    for (const [k, v] of Object.entries(expected)) {
      if (k === "DATABASE_URL") continue;
      expect(env[k], k).toBe(v);
    }
    // the node's own bucket key beyond the profile arrives too
    expect(env.PAPER_ENFORCE_MODE).toBe("true");
    expect(env.RELEASE_SHA).toBe(SHA_1);
    expect(env.LITELLM_MASTER_KEY).toBe("value-of-LITELLM_VIRTUAL_KEY");
    expect(env).not.toHaveProperty("LITELLM_VIRTUAL_KEY");
    // CD2: the bucket's DATABASE_URL never wins over the declared state binding
    expect(env.DATABASE_URL).toMatch(/^postgres/);
    expect(env.DATABASE_URL).not.toBe("value-of-DATABASE_URL");
    // the sequencer asked OpenBao for exactly the profile keys minus the bound one
    expect(h.runtimeSecrets.reads.at(-1)).toMatchObject({
      env: ENV,
      slug: "poly",
    });
    expect(h.runtimeSecrets.reads.at(-1)?.keys).not.toContain("DATABASE_URL");
  });

  it("a fleet-inherited key present in the bucket but not declared is NOT injected; a declared secret_ref is", async () => {
    const h = harness();
    await stateUp(h, POLY_ID);
    await releaseApp(h, POLY_ID);
    const env = appCreates(h)[0]?.spec.services[0]?.env ?? {};
    expect(env.PAPER_ENFORCE_MODE).toBe("true");
    for (const k of Object.keys(INHERITED)) expect(env).not.toHaveProperty(k);
    // the port was asked for the declared set only (minus the state-bound DATABASE_URL)
    expect(h.runtimeSecrets.reads.at(-1)?.keys).toEqual(
      DECLARED.filter((k) => k !== "DATABASE_URL")
    );
    expect(JSON.stringify(h.log.lines)).not.toContain("inherited-");
  });

  it("starts a database-consuming node app through the DB CA trust wrapper, keeping its argv", async () => {
    const h = harness();
    await stateUp(h, POLY_ID);
    await releaseApp(h, POLY_ID);
    const svc = appCreates(h)[0]?.spec.services[0];
    expect(svc?.command?.[0]).toBe("/bin/sh");
    expect(svc?.args).toEqual(["sh", "-c", "echo app"]);
  });

  it("sends the interim provider allowlist and the catalog countries on the create", async () => {
    const h = harness();
    await stateUp(h, POLY_ID);
    await releaseApp(h, POLY_ID);
    const req = appCreates(h)[0];
    expect(req?.allowProviders).toEqual(ALLOWED);
    expect(req?.spec.placement).toEqual({
      requiredCountryCodes: ["FI", "NL", "PT", "UA"],
    });
    const step = h.log.lines.find(
      (l) =>
        l.msg === "node_deploy_step" &&
        l.fields.step === "placement_constrained"
    );
    expect(step?.fields.reason).toBe("allow=2 countries=FI,NL,PT,UA");
  });

  it("a state workload is never constrained by the app allowlist or countries", async () => {
    const h = harness();
    await stateUp(h, POLY_ID);
    const db = h.payer.createRequests.find((r) => r.spec.name === "canary-db");
    expect(db?.allowProviders).toBeUndefined();
    expect(db?.spec.placement).toBeUndefined();
    expect(db?.spec.services[0]?.env).not.toHaveProperty("COGNI_NODE_ID");
  });

  it("no catalog countries and no allowlist send neither field (byte-identical wire)", async () => {
    const h = harness({ appProviders: [] });
    h.catalog.rows.set(POLY_ID, { slug: "poly", row: { name: "poly" } });
    await stateUp(h, POLY_ID);
    await releaseApp(h, POLY_ID);
    const req = appCreates(h)[0];
    expect(req).toBeDefined();
    expect("allowProviders" in (req ?? {})).toBe(false);
    expect(req?.spec.placement).toBeUndefined();
  });

  it("the operator's own workload gets RELEASE_SHA and bindings only, no node env, no placement", async () => {
    const h = harness();
    await stateUp(h, OPERATOR_NODE_ID);
    expect(await releaseApp(h, OPERATOR_NODE_ID)).toBe("driven");
    const req = appCreates(h)[0];
    const env = req?.spec.services[0]?.env ?? {};
    expect(env.RELEASE_SHA).toBe(SHA_1);
    expect(env).not.toHaveProperty("COGNI_NODE_ID");
    expect(env).not.toHaveProperty("NODE_NAME");
    expect(req?.spec.placement).toBeUndefined();
    expect(req?.spec.services[0]?.command).toEqual(["sh", "-c", "echo app"]);
    expect(h.runtimeSecrets.reads).toHaveLength(0);
  });
});

describe("a half env is never deployed (NO_HALF_ENV)", () => {
  it("a missing profile key parks nothing: waiting_dependency, no attempt, no create, key NAMES only", async () => {
    const h = harness();
    await stateUp(h, POLY_ID);
    delete h.runtimeSecrets.bucket.EVM_RPC_URL;
    h.runtimeSecrets.bucket.AUTH_SECRET = "";
    expect(await releaseApp(h, POLY_ID)).toBe("waiting_dependency");
    expect(appCreates(h)).toHaveLength(0);
    expect(await h.store.attemptsFor(h.key(POLY_ID, "canary"))).toHaveLength(0);
    const waiting = h.log.lines.find(
      (l) => l.msg === "node_deploy_step" && l.fields.step === "dependency"
    );
    expect(String(waiting?.fields.reason)).toContain("EVM_RPC_URL");
    expect(String(waiting?.fields.reason)).toContain("AUTH_SECRET");
    // never a value in any log line
    expect(JSON.stringify(h.log.lines)).not.toContain("value-of-");
    // once the keys exist the very next tick deploys, with the same release
    h.runtimeSecrets.bucket.EVM_RPC_URL = "rpc";
    h.runtimeSecrets.bucket.AUTH_SECRET = "auth";
    expect(await h.seq.step(h.key(POLY_ID, "canary"))).toBe("driven");
    expect(appCreates(h)).toHaveLength(1);
  });

  it("an unreachable secret store waits, creates nothing and burns no attempt", async () => {
    const h = harness();
    await stateUp(h, POLY_ID);
    h.runtimeSecrets.down = true;
    for (let i = 0; i < 4; i++)
      expect(await releaseApp(h, POLY_ID)).toBe("waiting_dependency");
    expect(appCreates(h)).toHaveLength(0);
    expect(await h.store.attemptsFor(h.key(POLY_ID, "canary"))).toHaveLength(0);
  });

  it("a node the image catalog does not know waits instead of deploying env-less", async () => {
    const h = harness();
    await stateUp(h, POLY_ID);
    h.catalog.rows.delete(POLY_ID);
    expect(await releaseApp(h, POLY_ID)).toBe("waiting_dependency");
    expect(appCreates(h)).toHaveLength(0);
  });

  it("a malformed catalog placement cell waits (never widens placement)", async () => {
    const h = harness();
    await stateUp(h, POLY_ID);
    h.catalog.rows.set(POLY_ID, {
      slug: "poly",
      row: { name: "poly", required_placement_countries: { production: [] } },
    });
    expect(await releaseApp(h, POLY_ID)).toBe("waiting_dependency");
    expect(appCreates(h)).toHaveLength(0);
  });
});

describe("an app may claim only its own node's host (task.5405)", () => {
  async function releaseHost(h: H, nodeId: string, host: string) {
    await h.store.recordRelease({
      nodeId,
      env: ENV,
      workload: "canary",
      sourceSha: SHA_1,
      spec: canaryApp({
        secretKeys: DECLARED,
        expose: { http: { host } },
      }),
      createdBy: "test",
    });
    return h.seq.step(h.key(nodeId, "canary"));
  }
  const attemptsOf = (h: H, nodeId: string) =>
    h.store.attemptsFor(h.key(nodeId, "canary"));

  it("poly deploys at poly.cognidao.org (its own host, allowed by the catalog regex)", async () => {
    const h = harness();
    await stateUp(h, POLY_ID);
    expect(await releaseHost(h, POLY_ID, "poly.cognidao.org")).toBe("driven");
    expect(appCreates(h)).toHaveLength(1);
  });

  it("node A cannot claim node B's host: refused with a reason BEFORE any paid create", async () => {
    const h = harness();
    await stateUp(h, POLY_ID);
    h.catalog.rows.set(TOKS_ID, {
      slug: "toks5",
      row: { name: "toks5" },
    });
    // poly asks for toks5's host: the regex admits it (toks5 is a node-deploy node), ownership does not
    await releaseHost(h, POLY_ID, "toks5.cognidao.org");
    expect(appCreates(h)).toHaveLength(0);
    const [a] = await attemptsOf(h, POLY_ID);
    expect(a?.phase === "closing" || a?.phase === "failed").toBe(true);
    expect(a?.error).toContain("edge_host_refused");
    expect(a?.error).toContain("poly");
  });

  it("operator hosts and a crossplane node's host are refused (not in the catalog-built regex)", async () => {
    for (const host of [
      "cognidao.org",
      "preview.cognidao.org",
      "test.cognidao.org",
      "beacon.cognidao.org",
    ]) {
      const h = harness();
      await stateUp(h, POLY_ID);
      await releaseHost(h, POLY_ID, host);
      expect(appCreates(h), host).toHaveLength(0);
      const [a] = await attemptsOf(h, POLY_ID);
      expect(a?.error, host).toContain("edge_host_refused");
    }
  });

  it("the operator's own canary still deploys at its canary host", async () => {
    const h = harness();
    await stateUp(h, OPERATOR_NODE_ID);
    expect(await releaseApp(h, OPERATOR_NODE_ID)).toBe("driven");
  });
});

// ---------------------------------------------------------------------------------------------------
// ALWAYS_DEFER (story.5137): a release recorded before node CI published its image
// ---------------------------------------------------------------------------------------------------

const POLY_REPO = "ghcr.io/cogni-dao/poly";
const SHA_N = "9".repeat(40);
const POLY_DIGEST = `${POLY_REPO}@sha256:${"c".repeat(64)}`;

async function recordPending(h: H, sha: string) {
  return h.store.recordRelease({
    nodeId: POLY_ID,
    env: ENV,
    workload: "canary",
    sourceSha: sha,
    spec: canaryApp({
      image: `${POLY_REPO}:sha-${sha}`,
      imagePending: true,
      bindings: [],
      secretKeys: DECLARED,
      expose: { http: { host: POLY_HOST } },
    }),
    createdBy: "test",
  });
}

describe("a pending image is pinned before any paid create (story.5137)", () => {
  it("waits as DependencyNotReady (no attempt, nothing paid) until node CI publishes, then pins the digest write-once and deploys it", async () => {
    const h = harness();
    const { release } = await recordPending(h, SHA_1);

    expect(await h.seq.step(h.key(POLY_ID, "canary"))).toBe(
      "waiting_dependency"
    );
    expect(appCreates(h)).toHaveLength(0);
    expect(await h.store.attemptsFor(h.key(POLY_ID, "canary"))).toHaveLength(0);
    expect(h.images.calls).toEqual([
      { imageRepository: POLY_REPO, sourceSha: SHA_1 },
    ]);
    const waiting = h.log.lines.find(
      (l) => l.msg === "node_deploy_step" && l.fields.step === "dependency"
    );
    expect(String(waiting?.fields.reason)).toContain("not published yet");

    // node CI publishes; the next tick pins and deploys, with the SAME release
    h.images.published.set(SHA_1, POLY_DIGEST);
    expect(await h.seq.step(h.key(POLY_ID, "canary"))).toBe("driven");
    const pinned = await h.store.getRelease(release.id);
    expect(pinned?.resolvedImage).toBe(POLY_DIGEST);
    expect(pinned?.spec.image).toBe(POLY_DIGEST);
    expect(pinned?.spec.imagePending).toBeUndefined();
    expect(appCreates(h)).toHaveLength(1);
    expect(appCreates(h)[0]?.spec.services[0]?.image).toBe(POLY_DIGEST);
  });

  it("pins ONCE: a re-tagged image never changes a pinned release, and a converged release asks the registry no more", async () => {
    const h = harness();
    const { release } = await recordPending(h, SHA_1);
    h.images.published.set(SHA_1, POLY_DIGEST);
    await h.seq.step(h.key(POLY_ID, "canary"));
    expect(h.images.calls).toHaveLength(1);

    const other = `${POLY_REPO}@sha256:${"d".repeat(64)}`;
    h.images.published.set(SHA_1, other);
    const again = await h.store.pinResolvedImage(release.id, other);
    expect(again.resolvedImage).toBe(POLY_DIGEST);
    expect(again.spec.image).toBe(POLY_DIGEST);

    expect(await h.seq.step(h.key(POLY_ID, "canary"))).toBe("converged");
    expect(h.images.calls).toHaveLength(1);
  });

  it("a registry outage waits instead of failing or paying", async () => {
    const h = harness();
    await recordPending(h, SHA_1);
    h.images.down = true;
    expect(await h.seq.step(h.key(POLY_ID, "canary"))).toBe(
      "waiting_dependency"
    );
    expect(appCreates(h)).toHaveLength(0);
    expect(await h.store.attemptsFor(h.key(POLY_ID, "canary"))).toHaveLength(0);
  });

  it("raises alert/image_not_published once it has waited past imageAlertMs, still paying nothing", async () => {
    const h = harness({ imageAlertMs: 1_800_000 });
    await recordPending(h, SHA_1);
    const alerts = () =>
      h.log.lines.filter(
        (l) =>
          l.msg === "node_deploy_alert" &&
          l.fields.outcome === "image_not_published"
      );
    await h.seq.step(h.key(POLY_ID, "canary"));
    expect(alerts()).toHaveLength(0);

    await h.clock.sleep(1_800_000);
    expect(await h.seq.step(h.key(POLY_ID, "canary"))).toBe(
      "waiting_dependency"
    );
    expect(alerts()).toHaveLength(1);
    expect(appCreates(h)).toHaveLength(0);
    // throttled: the next tick does not write a second line
    await h.seq.step(h.key(POLY_ID, "canary"));
    expect(alerts()).toHaveLength(1);
  });

  it("LATEST_RELEASE_WINS: a newer release supersedes an older one that never started, which never gets an attempt or a registry read", async () => {
    const h = harness();
    const older = await recordPending(h, SHA_1);
    // the older sha's image is never published; a newer release replaces it
    const newer = await recordPending(h, SHA_N);
    h.images.published.set(SHA_N, POLY_DIGEST);

    expect(
      (await h.store.getDesired(h.key(POLY_ID, "canary")))?.releaseId
    ).toBe(newer.release.id);
    expect(await h.seq.step(h.key(POLY_ID, "canary"))).toBe("driven");

    expect(h.images.calls).toEqual([
      { imageRepository: POLY_REPO, sourceSha: SHA_N },
    ]);
    const attempts = await h.store.attemptsFor(h.key(POLY_ID, "canary"));
    expect(attempts.map((a) => a.releaseId)).toEqual([newer.release.id]);
    expect((await h.store.getRelease(older.release.id))?.resolvedImage).toBe(
      undefined
    );
    expect(appCreates(h)[0]?.spec.services[0]?.image).toBe(POLY_DIGEST);
  });

  it("a sequencer with no image resolver configured waits on a pending release and never creates", async () => {
    const h = harness();
    const bare = new NodeDeploySequencer({
      store: h.store,
      payer: h.payer,
      edge: undefined,
      probe: new FakeProbe(h.payer, new FakeDns([]), []),
      secrets: new MemorySecrets(),
      clock: h.clock,
      log: new MemoryLog(),
      config: {
        ...DEFAULT_SEQUENCER_CONFIG,
        namespace: "cogni-production",
        environment: ENV,
      } as SequencerConfig,
    });
    await recordPending(h, SHA_1);
    expect(await bare.step(h.key(POLY_ID, "canary"))).toBe(
      "waiting_dependency"
    );
    expect(appCreates(h)).toHaveLength(0);
  });
});

vi.mock("node:https", () => ({ request: vi.fn() }));

const BUNDLE_REF = `ghcr.io/example/node@sha256:${"b".repeat(64)}`;
const PUBLIC_IMAGE = `ghcr.io/example/node@sha256:${"c".repeat(64)}`;
const HELPER_IMAGE = `ghcr.io/example/node-helper@sha256:${"d".repeat(64)}`;
const SERVICE_DECLARATIONS = [
  nodeServiceSpecSchema.parse({
    name: "canary",
    artifact: { name: "app" },
    port: 3000,
    visibility: "public",
    runtime_profile: "cogni-node-app-v1",
    bindings: { HELPER_URL: "helper" },
    resources: { cpu_units: 1, memory_mi: 256, storage_mi: 256 },
  }),
  nodeServiceSpecSchema.parse({
    name: "helper",
    artifact: { name: "helper" },
    port: 8181,
    visibility: "private",
    envs: ["candidate-a", "preview"],
    secret_refs: [{ key: "HELPER_ACCESS" }],
    resources: { cpu_units: 0.25, memory_mi: 256, storage_mi: 256 },
  }),
];
function companionSpec(): NodeWorkloadSpec {
  return canaryApp({
    bindings: [],
    image: `ghcr.io/example/node:sha-${SHA_1}`,
    imagePending: true,
    serviceName: "canary",
    secretKeys: [...COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS],
    env: { HELPER_URL: "http://helper:8181" },
    companions: [
      {
        name: "helper",
        image: `ghcr.io/example/node:sha-${SHA_1}`,
        imagePending: true,
        port: 8181,
        ready: "/readyz",
        cpu: 0.25,
        memoryMi: 256,
        storageMi: 256,
        env: { MODE: "synthetic" },
        secretKeys: ["HELPER_ACCESS"],
      },
    ],
    artifactPlan: {
      repository: "example/node",
      imageRepository: "ghcr.io/example/node",
      services: SERVICE_DECLARATIONS,
    },
    health: {
      version: "/version",
      ready: "/readyz",
      qualification: { path: "/api/v1/deploy/qualification", timeoutMs: 20000 },
    },
    expose: { http: { host: "poly-preview.cognidao.org" } },
  });
}
function installBundle(h: H) {
  const calls: { acceptedDigest?: string }[] = [];
  h.images.resolveArtifactBundle = async (input) => {
    calls.push(input);
    return {
      digestRef: BUNDLE_REF,
      bundle: {
        schema_version: 1,
        node_id: POLY_ID,
        source: { repository: "example/node", sha: SHA_1 },
        artifacts: [
          { name: "app", image: PUBLIC_IMAGE },
          { name: "helper", image: HELPER_IMAGE },
        ],
        services: [
          { name: "canary", artifact: "app" },
          { name: "helper", artifact: "helper" },
        ],
      },
    };
  };
  h.images.checkImageManifests = async () => true;
  h.runtimeSecrets.bucket.HELPER_ACCESS = "helper-only";
  return calls;
}
function proofResponder(
  h: H,
  change?: (body: Record<string, unknown>, mode: string) => void
) {
  const modes: string[] = [];
  h.probe.qualification = async (input) => {
    modes.push(input.mode);
    const claims = decodeJwt(input.token);
    expect(claims.iss).toBe("cogni-operator");
    expect(claims.aud).toBe("cogni-release-qualification");
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(60);
    const {
      iss: _iss,
      aud: _aud,
      exp: _exp,
      iat: _iat,
      jti,
      mode,
      helperBootId: _boot,
      companionBootIds,
      companionReadiness,
      ...subject
    } = claims;
    const declared = requiredFixture(
      await h.store.getRelease(String(claims.releaseId))
    );
    expect(companionReadiness).toEqual(
      Object.fromEntries(
        (declared.spec.companions ?? []).map((c) => [
          c.name,
          { port: c.port, path: c.ready },
        ])
      )
    );
    if (input.mode === "qualify") expect(companionBootIds).toBeNull();
    expect(_boot).toBe(
      input.mode === "readback" && declared.spec.companions?.length
        ? "boot-one"
        : null
    );
    const body: Record<string, unknown> = {
      ...subject,
      status: "qualified",
      helper: { service: "helper", buildSha: SHA_1, bootId: "boot-one" },
      evidenceId: "receipt-one",
      observedAt: new Date(h.clock.now()).toISOString(),
      nonce: jti,
      companions: Object.fromEntries(
        Object.entries(
          companionReadiness as Record<string, { port: number; path: string }>
        ).map(([name, ready]) => [
          name,
          {
            buildSha: SHA_1,
            bootId: `boot-${name === "helper" ? "one" : name}`,
            ready: {
              ...ready,
              status: 200,
              observedAt: new Date(h.clock.now()).toISOString(),
            },
          },
        ])
      ),
    };
    if (input.mode === "readback" && companionBootIds !== undefined)
      expect(companionBootIds).toEqual(
        Object.fromEntries(
          Object.entries(
            body.companions as Record<string, { bootId: string }>
          ).map(([n, c]) => [n, c.bootId])
        )
      );
    change?.(body, String(mode));
    return {
      status: body.status === "failed" ? 503 : 200,
      body: JSON.stringify(body),
      ms: 1,
    };
  };
  return modes;
}
async function companionRelease(h: H, spec = companionSpec()) {
  return h.store.recordRelease({
    nodeId: POLY_ID,
    env: "preview",
    workload: "canary",
    sourceSha: SHA_1,
    spec,
    createdBy: "test",
  });
}

describe("private release companions", () => {
  it("seals the complete bundle, projects union once per assembly, and qualifies before edge", async () => {
    const h = harness({ environment: "preview" });
    const calls = installBundle(h);
    const modes = proofResponder(h);
    const { release } = await companionRelease(h);
    expect(
      await h.seq.step({ ...h.key(POLY_ID, "canary"), env: "preview" })
    ).toBe("driven");
    const sealed = await h.store.getRelease(release.id);
    expect(sealed?.spec.artifactPlan?.bundleDigest).toBe(BUNDLE_REF);
    expect(sealed?.spec.image).toBe(PUBLIC_IMAGE);
    const services = appCreates(h)[0]?.spec.services;
    expect(services).toHaveLength(2);
    expect(services?.[1]?.expose).toEqual([
      { port: 8181, as: 8181, global: false },
    ]);
    expect(services?.[1]?.image).toBe(HELPER_IMAGE);
    expect(services?.[1]?.env).toMatchObject({
      HELPER_ACCESS: "helper-only",
      COGNI_REPO_SHA: SHA_1,
      MODE: "synthetic",
    });
    expect(services?.[1]?.env).not.toHaveProperty("AUTH_SECRET");
    expect(services?.[1]?.env).not.toHaveProperty("DATABASE_URL");
    expect(services?.[0]?.env).not.toHaveProperty("HELPER_ACCESS");
    expect(services?.[0]?.env?.HELPER_URL).toBe("http://helper:8181");
    expect(
      h.runtimeSecrets.reads.every(
        (r) =>
          r.keys.includes("HELPER_ACCESS") && r.keys.includes("AUTH_SECRET")
      )
    ).toBe(true);
    expect(modes).toEqual(["qualify", "readback"]);
    const attempt = h.store.attempts.find((a) => a.releaseId === release.id);
    expect(attempt?.phase).toBe("active");
    expect(
      attempt?.steps.find((s) => s.step === "qualification")?.reason
    ).toContain("boot-one");
    expect(calls).toHaveLength(1);
  });

  it.each([
    "allocation",
    "boot",
    "source",
    "nonce",
    "stale",
    "order",
    "node",
    "env",
    "service",
  ])("healthy readiness cannot move edge with %s failure", async (failure) => {
    const h = harness({ environment: "preview" });
    installBundle(h);
    // Establish blue with the existing one-container path.
    await companionRelease(
      h,
      canaryApp({
        bindings: [],
        expose: { http: { host: "poly-preview.cognidao.org" } },
      })
    );
    const key = { ...h.key(POLY_ID, "canary"), env: "preview" };
    await h.seq.step(key);
    const blue = h.store.attempts.find((a) => a.phase === "active");
    const before = [...h.dns.records.values()].map((r) => r.content);
    const modes = proofResponder(h, (body, mode) => {
      if (failure === "order") body.status = "failed";
      if (mode !== "readback") return;
      if (failure === "node") body.nodeId = TOKS_ID;
      if (failure === "env") body.env = "production";
      if (failure === "service") body.services = { canary: PUBLIC_IMAGE };
      if (failure === "allocation") body.allocation = "old-allocation";
      if (failure === "boot")
        body.helper = {
          service: "helper",
          buildSha: SHA_1,
          bootId: "restarted",
        };
      if (failure === "source") body.sourceSha = "f".repeat(40);
      if (failure === "nonce") body.nonce = "stale-nonce";
      if (failure === "stale")
        body.observedAt = new Date(h.clock.now() - 61000).toISOString();
    });
    const { release } = await companionRelease(h);
    await h.seq.step(key);
    expect(
      h.store.attempts.find((a) => a.releaseId === release.id)?.phase
    ).toBe("failed");
    expect(h.store.attempts.find((a) => a.id === blue?.id)?.phase).toBe(
      "active"
    );
    expect([...h.dns.records.values()].map((r) => r.content)).toEqual(before);
    expect(modes).toEqual(
      failure === "order" ? ["qualify"] : ["qualify", "readback"]
    );
  });

  it("missing publication stays pending; invalid coverage parks before any paid create", async () => {
    const h = harness({ environment: "preview" });
    installBundle(h);
    const valid = h.images.resolveArtifactBundle;
    h.images.resolveArtifactBundle = async () => null;
    await companionRelease(h);
    const key = { ...h.key(POLY_ID, "canary"), env: "preview" };
    expect(await h.seq.step(key)).toBe("waiting_dependency");
    expect(h.store.attempts).toHaveLength(0);
    expect(h.payer.createRequests).toHaveLength(0);
    h.images.resolveArtifactBundle = async (input) => {
      const publication = await valid?.(input);
      return publication
        ? {
            ...publication,
            bundle: { ...(publication.bundle as object), services: [] },
          }
        : null;
    };
    expect(await h.seq.step(key)).toBe("parked");
    expect(h.store.attempts[0]?.error).toContain("artifact_bundle_invalid");
    expect(h.payer.createRequests).toHaveLength(0);
  });

  it("later environments reuse the accepted bundle by digest and prune the helper", async () => {
    const h = harness({ environment: "preview" });
    const calls = installBundle(h);
    proofResponder(h);
    await companionRelease(h);
    await h.seq.step({ ...h.key(POLY_ID, "canary"), env: "preview" });
    const first = h.store.attempts[0];
    expect(first?.phase).toBe("active");
    const { companions: _helpers, ...unpruned } = companionSpec();
    const spec = {
      ...unpruned,
      env: {},
      expose: { http: { host: POLY_HOST } },
    };
    const { release } = await h.store.recordRelease({
      nodeId: POLY_ID,
      env: "production",
      workload: "canary",
      sourceSha: SHA_1,
      spec,
      createdBy: "test",
    });
    // Same store, another environment's normal sequencer. Proof response is explicitly not_declared.
    const original = h.probe.qualification;
    h.probe.qualification = async (input) => {
      const res = await original?.(input);
      if (!res) throw new Error("missing probe");
      const b = JSON.parse(res.body);
      b.status = "not_declared";
      b.helper = null;
      b.companions = {};
      delete b.evidenceId;
      return { ...res, body: JSON.stringify(b) };
    };
    const seq = new NodeDeploySequencer({
      store: h.store,
      payer: h.payer,
      edge: new EdgeRouter(h.dns, edgeHostRegexFor(["poly"])),
      probe: h.probe,
      secrets: new MemorySecrets(),
      runtime: { catalog: h.catalog, secrets: h.runtimeSecrets },
      images: h.images,
      clock: h.clock,
      log: h.log,
      config: {
        ...DEFAULT_SEQUENCER_CONFIG,
        environment: "production",
        namespace: "prod",
      },
    });
    await seq.step(h.key(POLY_ID, "canary"));
    expect(calls[1]?.acceptedDigest).toBe(BUNDLE_REF);
    expect(
      (await h.store.getRelease(release.id))?.spec.artifactPlan?.bundleDigest
    ).toBe(BUNDLE_REF);
    expect(appCreates(h).at(-1)?.spec.services).toHaveLength(1);
  });
});

function declarationInput() {
  const spec = buildTestRepoSpec({
    node_id: POLY_ID,
    deployment: { services: SERVICE_DECLARATIONS },
  });
  const manifest = {
    apiVersion: "score.dev/v1b1",
    metadata: {
      name: "canary",
      annotations: {
        "cogni.dev/exclusive": "false",
        "cogni.dev/qualification-path": "/api/v1/deploy/qualification",
        "cogni.dev/qualification-timeout-ms": "20000",
      },
    },
    containers: {
      helper: {
        image: ".",
        resources: { requests: { cpu: "250m", memory: "256Mi" } },
        readinessProbe: { httpGet: { path: "/readyz", port: 8181 } },
      },
      app: {
        image: ".",
        resources: { requests: { cpu: "1", memory: "256Mi" } },
        readinessProbe: { httpGet: { path: "/readyz", port: 3000 } },
      },
    },
    service: { ports: { web: { port: 80, targetPort: 3000 } } },
    resources: {
      web: { type: "route", params: { host: POLY_HOST, path: "/", port: 80 } },
    },
  };
  return {
    spec,
    manifest,
    resolve: (environment = "preview") =>
      resolveWorkloadDeclaration({
        repoSpecText: stringify(spec),
        manifests: [
          { path: ".cogni/workloads/canary.yaml", text: stringify(manifest) },
        ],
        nodeId: POLY_ID,
        env: environment,
        workload: "canary",
        pendingImage: `ghcr.io/example/node:sha-${SHA_1}`,
        sourceRepository: "example/node",
      }),
  };
}

describe("same-source Score/declaration bridge", () => {
  it("matches public app alias independently of order and cascades the declared environment gate", () => {
    const d = declarationInput();
    const preview = d.resolve();
    const prod = d.resolve("production");
    expect(preview.serviceName).toBe("canary");
    expect(preview.env.HELPER_URL).toBe("http://helper:8181");
    expect(preview.companions?.[0]?.secretKeys).toEqual(["HELPER_ACCESS"]);
    expect(preview.companions?.[0]?.secretKeys).not.toContain("AUTH_SECRET");
    expect(prod.companions).toBeUndefined();
    expect(prod.env).not.toHaveProperty("HELPER_URL");
    expect(prod.artifactPlan?.services).toHaveLength(2);
  });
  it.each([
    "port",
    "undeclared",
    "profile",
    "auth-secret",
    "db-secret",
    "app-profile",
  ])("refuses %s even when production excludes the helper", (failure) => {
    const d = declarationInput();
    const helper = d.spec.deployment?.services[1];
    if (!helper) throw new Error("fixture");
    if (failure === "port") helper.port = 8182;
    if (failure === "undeclared") helper.name = "other-helper";
    if (failure === "profile") helper.runtime_profile = "cogni-node-app-v1";
    if (failure === "auth-secret")
      helper.secret_refs = [{ key: "AUTH_SECRET" }];
    if (failure === "db-secret") helper.secret_refs = [{ key: "DOLTGRES_URL" }];
    if (failure === "app-profile")
      helper.secret_refs = [{ key: "BILLING_INGEST_TOKEN" }];
    expect(() => d.resolve("production")).toThrow(DeclarationError);
  });
  it("concurrent environments cannot seal different bundles for the same source", async () => {
    const h = harness();
    installBundle(h);
    const a = await companionRelease(h);
    const b = await h.store.recordRelease({ ...a.release, env: "candidate-a" });
    const publication = await h.images.resolveArtifactBundle?.({
      imageRepository: "ghcr.io/example/node",
      sourceSha: SHA_1,
    });
    if (!publication) throw new Error("publication fixture");
    const selectedA = selectReleaseBundle(a.release, publication);
    const selectedB = selectReleaseBundle(b.release, {
      ...publication,
      digestRef: `ghcr.io/example/node@sha256:${"e".repeat(64)}`,
    });
    const result = await Promise.all([
      h.store.pinResolvedBundle(a.release.id, selectedA),
      h.store.pinResolvedBundle(b.release.id, selectedB),
    ]);
    expect(result.filter(Boolean)).toHaveLength(1);
    expect(await h.store.acceptedBundle(b.release)).toBe(BUNDLE_REF);
    expect(
      (await h.store.getRelease(b.release.id))?.resolvedImage
    ).toBeUndefined();
  });
});

describe("bounded OCI publication read", () => {
  const digest = (s: string) =>
    `sha256:${createHash("sha256").update(s).digest("hex")}`;
  function registry(redirect = "", corrupt = false) {
    const payload = JSON.stringify({
      schema_version: 1,
      node_id: POLY_ID,
      source: { repository: "example/node", sha: SHA_1 },
      artifacts: [
        { name: "app", image: PUBLIC_IMAGE },
        { name: "helper", image: HELPER_IMAGE },
      ],
      services: [
        { name: "canary", artifact: "app" },
        { name: "helper", artifact: "helper" },
      ],
    });
    const manifest = JSON.stringify({
      artifactType: NODE_BUNDLE_ARTIFACT_TYPE,
      layers: [
        {
          digest: digest(payload),
          size: Buffer.byteLength(payload),
          mediaType: NODE_BUNDLE_PAYLOAD_MEDIA_TYPE,
          annotations: {
            "org.opencontainers.image.title": NODE_BUNDLE_PAYLOAD_FILE,
          },
        },
      ],
    });
    const calls: {
      url: string;
      authorization: string | null;
      redirect?: RequestRedirect;
    }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
        ...(init?.redirect ? { redirect: init.redirect } : {}),
      });
      if (url.includes("/token?"))
        return new Response(JSON.stringify({ token: "registry-only" }));
      if (url.includes("/manifests/"))
        return new Response(manifest, {
          headers: { "docker-content-digest": digest(manifest) },
        });
      if (
        url.includes("/blobs/") &&
        new URL(url).origin === "https://ghcr.io" &&
        redirect
      )
        return new Response(null, {
          status: 307,
          headers: { location: redirect },
        });
      return new Response(corrupt ? "corrupted" : payload);
    };
    return {
      resolver: new GhcrBuiltImageResolver(fetcher),
      calls,
      ref: `ghcr.io/example/node@${digest(manifest)}`,
    };
  }
  it("reads accepted publication by digest and strips registry bearer on its one allowed blob redirect", async () => {
    const r = registry(
      "https://pkg-containers.githubusercontent.com/ghcr1/blobs/object"
    );
    const result = await r.resolver.resolveArtifactBundle({
      imageRepository: "ghcr.io/example/node",
      sourceSha: SHA_1,
      acceptedDigest: r.ref,
    });
    expect(result?.digestRef).toBe(r.ref);
    expect(r.calls[1]?.url).toContain(`/manifests/${r.ref.split("@")[1]}`);
    expect(r.calls.at(-1)?.authorization).toBeNull();
    expect(r.calls.at(-1)?.redirect).toBe("error");
  });
  it("refuses an external redirect without sending bearer credentials there", async () => {
    const r = registry("https://attacker.invalid/blob");
    await expect(
      r.resolver.resolveArtifactBundle({
        imageRepository: "ghcr.io/example/node",
        sourceSha: SHA_1,
      })
    ).rejects.toMatchObject({ invalid: true });
    expect(r.calls.some((c) => c.url.includes("attacker.invalid"))).toBe(false);
  });
  it("refuses payload bytes that differ from the manifest digest and size", async () => {
    const r = registry("", true);
    await expect(
      r.resolver.resolveArtifactBundle({
        imageRepository: "ghcr.io/example/node",
        sourceSha: SHA_1,
      })
    ).rejects.toMatchObject({ invalid: true });
  });
});

describe("durable qualification receipts", () => {
  it("resumes a saved qualification with readback only after losing the proven-phase write", async () => {
    const h = harness({ environment: "preview" });
    installBundle(h);
    const modes = proofResponder(h);
    await companionRelease(h);
    const key = { ...h.key(POLY_ID, "canary"), env: "preview" };
    const update = h.store.updateAttempt.bind(h.store);
    let loseWrite = true;
    h.store.updateAttempt = async (id, patch) => {
      if (patch.phase === "proven" && loseWrite) {
        loseWrite = false;
        throw new Error("lost phase write");
      }
      return update(id, patch);
    };
    await expect(h.seq.step(key)).rejects.toThrow("lost phase write");
    expect(h.dns.records.size).toBe(0);
    await h.seq.step(key);
    expect(h.store.attempts[0]?.phase).toBe("active");
    expect(modes).toEqual(["qualify", "readback", "readback"]);
    expect(appCreates(h)).toHaveLength(1);
  });
  it("a reservation write failure refuses dispatch and edge movement", async () => {
    const h = harness({ environment: "preview" });
    installBundle(h);
    const modes = proofResponder(h);
    await companionRelease(h);
    const append = h.store.appendAttemptStep.bind(h.store);
    h.store.appendAttemptStep = async (id, step) => {
      if (step.step === "qualification_started")
        throw new Error("receipt store unavailable");
      return append(id, step);
    };
    await h.seq.step({ ...h.key(POLY_ID, "canary"), env: "preview" });
    expect(modes).toEqual([]);
    expect(h.dns.records.size).toBe(0);
    expect(h.store.attempts[0]?.phase).toBe("failed");
  });
});

it("reads back the complete winning seal after a lost transaction response", async () => {
  const h = harness({ environment: "preview" });
  const calls = installBundle(h);
  proofResponder(h);
  const pin = h.store.pinResolvedBundle.bind(h.store);
  h.store.pinResolvedBundle = async (id, spec) => {
    await pin(id, spec);
    throw new Error("lost COMMIT reply");
  };
  const { release } = await companionRelease(h);
  await h.seq.step({ ...h.key(POLY_ID, "canary"), env: "preview" });
  expect(h.store.attempts[0]?.phase).toBe("active");
  expect(
    (await h.store.getRelease(release.id))?.spec.artifactPlan?.bundleDigest
  ).toBe(BUNDLE_REF);
  expect(calls).toHaveLength(1);
  expect(appCreates(h)).toHaveLength(1);
});

function requiredFixture<T>(value: T | undefined | null): T {
  if (value === undefined || value === null)
    throw new Error("missing test fixture");
  return value;
}

describe("review repair digest and companion gates", () => {
  it.each([
    "new",
    "accepted",
    "sealed",
  ])("missing helper digest stays pending for %s set", async (state) => {
    const h = harness({ environment: "preview" });
    const calls = installBundle(h);
    const { release } = await companionRelease(h);
    const publication = await h.images.resolveArtifactBundle?.({
      imageRepository: "ghcr.io/example/node",
      sourceSha: SHA_1,
    });
    if (!publication) throw new Error("fixture");
    if (state === "sealed")
      await h.store.pinResolvedBundle(
        release.id,
        selectReleaseBundle(release, publication)
      );
    if (state === "accepted") {
      const other = await h.store.recordRelease({
        ...release,
        env: "candidate-a",
      });
      await h.store.pinResolvedBundle(
        other.release.id,
        selectReleaseBundle(other.release, publication)
      );
    }
    const checks: readonly string[][] = [];
    h.images.checkImageManifests = async (images) => {
      (checks as string[][]).push([...images]);
      return false;
    };
    calls.length = 0;
    expect(
      await h.seq.step({ ...h.key(POLY_ID, "canary"), env: "preview" })
    ).toBe("waiting_dependency");
    expect(checks).toContainEqual([PUBLIC_IMAGE, HELPER_IMAGE]);
    expect(h.store.attempts).toHaveLength(0);
    expect(h.payer.createRequests).toHaveLength(0);
    if (state === "accepted") expect(calls[0]?.acceptedDigest).toBe(BUNDLE_REF);
    if (state === "sealed") expect(calls).toHaveLength(0);
  });

  it("a planned attempt resumed after runner loss cannot create an unavailable accepted image", async () => {
    const h = harness({ environment: "preview" });
    installBundle(h);
    const { release } = await companionRelease(h);
    const publication = requiredFixture(
      await h.images.resolveArtifactBundle?.({
        imageRepository: "ghcr.io/example/node",
        sourceSha: SHA_1,
      })
    );
    await h.store.pinResolvedBundle(
      release.id,
      selectReleaseBundle(release, publication)
    );
    const planned = await h.store.insertAttempt(
      release.id,
      () => "resume-manifest-gate"
    );
    h.images.checkImageManifests = async () => false;
    await h.seq.step({ ...h.key(POLY_ID, "canary"), env: "preview" });
    expect(h.payer.createRequests).toHaveLength(0);
    expect(h.store.attempts).toHaveLength(1);
    expect(h.store.attempts[0]?.id).toBe(planned.id);
    expect(h.store.attempts[0]?.phase).toBe("planned");
  });

  it.each([
    "missing-B",
    "extra",
    "revision-B",
    "restart-B",
    "stale-ready",
    "failed-ready",
    "wrong-path",
    "wrong-port",
    "declared-failure",
    "pass",
  ])("handles %s while A proof passes and preserves blue", async (failure) => {
    const h = harness({ environment: "preview" });
    installBundle(h);
    await companionRelease(
      h,
      canaryApp({
        bindings: [],
        expose: { http: { host: "poly-preview.cognidao.org" } },
      })
    );
    const key = { ...h.key(POLY_ID, "canary"), env: "preview" };
    await h.seq.step(key);
    const blue = h.store.attempts[0];
    const edge = [...h.dns.records.values()].map((r) => r.content);
    const spec = companionSpec();
    const b = {
      ...requiredFixture(spec.companions?.[0]),
      name: "helper-b",
      port: 8282,
      ready:
        failure === "declared-failure"
          ? "/deliberately-failing"
          : "/declared-ready",
    };
    spec.companions = [...requiredFixture(spec.companions), b];
    requiredFixture(spec.artifactPlan).services = [
      ...requiredFixture(spec.artifactPlan).services,
      nodeServiceSpecSchema.parse({
        name: "helper-b",
        resources: { cpu_units: 0.25, memory_mi: 256, storage_mi: 256 },
        artifact: { name: "helper-b" },
        port: 8282,
        visibility: "private",
      }),
    ];
    const resolve = requiredFixture(h.images.resolveArtifactBundle);
    h.images.resolveArtifactBundle = async (input) => {
      const pub = await resolve(input);
      if (!pub) return null;
      const bundle = pub.bundle as {
        artifacts: unknown[];
        services: unknown[];
      };
      return {
        ...pub,
        bundle: {
          ...bundle,
          artifacts: [
            ...bundle.artifacts,
            {
              name: "helper-b",
              image: `ghcr.io/example/node-helper-b@sha256:${"e".repeat(64)}`,
            },
          ],
          services: [
            ...bundle.services,
            { name: "helper-b", artifact: "helper-b" },
          ],
        },
      };
    };
    proofResponder(h, (body, mode) => {
      const cs = body.companions as Record<
        string,
        {
          buildSha: string;
          bootId: string;
          ready: {
            port: number;
            path: string;
            status: number;
            observedAt: string;
          };
        }
      >;
      if (!cs["helper-b"])
        cs["helper-b"] = {
          buildSha: SHA_1,
          bootId: "boot-helper-b",
          ready: {
            port: 8282,
            path: "/declared-ready",
            status: 200,
            observedAt: new Date(h.clock.now()).toISOString(),
          },
        };
      if (
        failure === "declared-failure" &&
        requiredFixture(cs["helper-b"]).ready.path === "/deliberately-failing"
      )
        body.status = "failed";
      if (mode !== "readback") return;
      if (failure === "missing-B") delete cs["helper-b"];
      else if (failure === "extra")
        cs.extra = { ...requiredFixture(cs.helper) };
      else if (failure === "revision-B")
        requiredFixture(cs["helper-b"]).buildSha = "f".repeat(40);
      else if (failure === "restart-B")
        requiredFixture(cs["helper-b"]).bootId = "restarted-b";
      else if (failure === "stale-ready")
        requiredFixture(cs["helper-b"]).ready.observedAt = new Date(
          h.clock.now() - 61000
        ).toISOString();
      else if (failure === "failed-ready")
        requiredFixture(cs["helper-b"]).ready.status = 503;
      else if (failure === "wrong-path")
        requiredFixture(cs["helper-b"]).ready.path = "/healthy-but-undeclared";
      else if (failure === "wrong-port")
        requiredFixture(cs["helper-b"]).ready.port = 8181;
    });
    const { release } = await companionRelease(h, spec);
    await h.seq.step(key);
    expect(
      h.store.attempts.find((a) => a.releaseId === release.id)?.phase
    ).toBe(failure === "pass" ? "active" : "failed");
    if (failure !== "pass") {
      expect(h.store.attempts.find((a) => a.id === blue?.id)?.phase).toBe(
        "active"
      );
      expect([...h.dns.records.values()].map((r) => r.content)).toEqual(edge);
    }
  });

  it("validates each binding against its private consumer before pruning", () => {
    const d = declarationInput();
    requiredFixture(d.spec.deployment).services.push(
      nodeServiceSpecSchema.parse({
        name: "helper-b",
        resources: { cpu_units: 0.25, memory_mi: 256, storage_mi: 256 },
        artifact: { name: "helper-b" },
        port: 8282,
        visibility: "private",
        envs: ["preview"],
      })
    );
    Object.assign(d.manifest.containers, {
      "helper-b": {
        ...d.manifest.containers.helper,
        readinessProbe: { httpGet: { path: "/readyz", port: 8282 } },
      },
    });
    requiredFixture(requiredFixture(d.spec.deployment).services[1]).bindings = {
      BACKEND_URL: "helper-b",
    };
    Object.assign(d.manifest.containers.app, {
      variables: { BACKEND_URL: "public-value" },
    });
    expect(
      d.resolve().companions?.find((c) => c.name === "helper")?.env.BACKEND_URL
    ).toBe("http://helper-b:8282");
    Object.assign(d.manifest.containers.helper, {
      variables: { BACKEND_URL: "conflict" },
    });
    expect(() => d.resolve("production")).toThrow(DeclarationError);
  });
});

describe("accepted manifest transport", () => {
  it.each([
    200, 401, 403, 404, 503, 307, 999,
  ])("checks digest without tag replacement, registry status %s", async (status) => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const resolver = new GhcrBuiltImageResolver(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/token?"))
        return new Response(JSON.stringify({ token: "scoped-pull" }));
      return new Response(null, {
        status: status === 999 ? 200 : status,
        headers: {
          "docker-content-digest":
            status === 999
              ? `sha256:${"f".repeat(64)}`
              : requiredFixture(HELPER_IMAGE.split("@")[1]),
          location: "https://attacker.invalid/manifest",
        },
      });
    });
    if ([503, 307, 999].includes(status))
      await expect(
        resolver.checkImageManifests([HELPER_IMAGE])
      ).rejects.toBeInstanceOf(BuiltImageRegistryError);
    else
      expect(await resolver.checkImageManifests([HELPER_IMAGE])).toBe(
        status === 200
      );
    expect(calls.map((c) => c.url)).toEqual([
      "https://ghcr.io/token?service=ghcr.io&scope=repository%3Aexample%2Fnode-helper%3Apull",
      `https://ghcr.io/v2/example/node-helper/manifests/${HELPER_IMAGE.split("@")[1]}`,
    ]);
    expect(calls[1]?.init).toMatchObject({
      method: "HEAD",
      redirect: "manual",
      headers: { authorization: "Bearer scoped-pull" },
    });
  });
  it("checks all selected images and never forwards a GHCR bearer to an upstream registry", async () => {
    const upstream = `registry.example/upstream@sha256:${"e".repeat(64)}`;
    const heads: string[] = [];
    const resolver = new GhcrBuiltImageResolver(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/token")
        return new Response(JSON.stringify({ token: "ghcr-only" }));
      heads.push(url.href);
      const image = url.hostname === "ghcr.io" ? PUBLIC_IMAGE : upstream;
      expect(new Headers(init?.headers).get("authorization")).toBe(
        url.hostname === "ghcr.io" ? "Bearer ghcr-only" : null
      );
      return new Response(null, {
        headers: {
          "docker-content-digest": requiredFixture(image.split("@")[1]),
        },
      });
    });
    expect(await resolver.checkImageManifests([PUBLIC_IMAGE, upstream])).toBe(
      true
    );
    expect(heads).toHaveLength(2);
  });
  it("checks a declared Docker Hub tag+digest by digest with only its own anonymous token", async () => {
    const digest = `sha256:${"e".repeat(64)}`;
    const calls: string[] = [];
    const resolver = new GhcrBuiltImageResolver(async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith("https://auth.docker.io/token?")) {
        expect(new Headers(init?.headers).get("authorization")).toBeNull();
        return new Response(JSON.stringify({ token: "docker-only" }));
      }
      expect(url).toBe(
        `https://registry-1.docker.io/v2/library/postgres/manifests/${digest}`
      );
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer docker-only"
      );
      return new Response(null, {
        headers: { "docker-content-digest": digest },
      });
    });
    expect(await resolver.checkImageManifests([`postgres:16@${digest}`])).toBe(
      true
    );
    expect(calls).toHaveLength(2);
  });

  it("bounds stalled manifest IO by the shared operation deadline", async () => {
    const resolver = new GhcrBuiltImageResolver(
      async (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("timeout")),
            { once: true }
          );
        }),
      5
    );
    await expect(
      resolver.checkImageManifests([HELPER_IMAGE])
    ).rejects.toMatchObject({ invalid: false });
  });
  it("refuses a node-built foreign repository but keeps explicit upstream digest semantics", async () => {
    const h = harness({ environment: "preview" });
    installBundle(h);
    const { release } = await companionRelease(h);
    const publication = await requiredFixture(h.images.resolveArtifactBundle)({
      imageRepository: "ghcr.io/example/node",
      sourceSha: SHA_1,
    });
    if (!publication) throw new Error("fixture");
    const foreign = `registry.example/upstream@sha256:${"e".repeat(64)}`;
    const bundle = publication.bundle as {
      artifacts: { name: string; image: string }[];
    };
    const changed = {
      ...publication,
      bundle: {
        ...bundle,
        artifacts: bundle.artifacts.map((a) =>
          a.name === "helper" ? { ...a, image: foreign } : a
        ),
      },
    };
    expect(() => selectReleaseBundle(release, changed)).toThrow(
      "repository mismatch"
    );
    const { imagePending: _pending, ...explicit } = requiredFixture(
      release.spec.companions?.[0]
    );
    const pinned = {
      ...release,
      spec: { ...release.spec, companions: [{ ...explicit, image: foreign }] },
    };
    expect(
      selectReleaseBundle(pinned, publication).artifactPlan?.selectedImages
        ?.helper
    ).toBe(foreign);
  });
});

describe("qualification transport owner reconciliation", () => {
  it.each([
    200, 302, 0,
  ])("verifies observed ingress TLS, selects HTTP Host and refuses redirect/retry (%s)", async (status) => {
    const mock = vi.mocked(httpsRequest);
    mock.mockReset();
    mock.mockImplementation((...args: unknown[]) => {
      const options = args[0] as RequestOptions;
      const callback = args[1];
      expect(options).toMatchObject({
        hostname: "green.provider.example",
        servername: "green.provider.example",
        port: 443,
        method: "POST",
        headers: {
          host: "node-preview.example",
          authorization: "Bearer challenge",
        },
      });
      const opts = options as RequestOptions;
      expect(opts.rejectUnauthorized).not.toBe(false);
      expect(opts.checkServerIdentity).toBeUndefined();
      const req = Object.assign(new EventEmitter(), {
        end() {
          queueMicrotask(() => {
            if (status === 0)
              req.emit("error", new Error("certificate identity mismatch"));
            else {
              const res = new IncomingMessage(new Socket());
              res.statusCode = status;
              res.headers = { location: "https://attacker.invalid" };
              if (typeof callback === "function") callback(res);
              res.push("evidence");
              res.push(null);
            }
            req.emit("close");
          });
          return req;
        },
      });
      return req as unknown as ClientRequest;
    });
    const result = await new HttpProbe().qualification({
      ingressHost: "green.provider.example",
      hostHeader: "node-preview.example",
      path: "/qualification",
      token: "challenge",
      mode: "qualify",
      timeoutMs: 20000,
    });
    expect(result.status).toBe(status);
    expect(mock).toHaveBeenCalledTimes(1);
  });
});
