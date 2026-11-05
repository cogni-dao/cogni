// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/sequencer-node-app.test`
 * Purpose: Prove a node APP deployed by the REAL sequencer gets the Crossplane lane's runtime env with
 *   OpenBao as custodian, that nothing is paid while that env cannot be resolved, and that placement
 *   (interim provider allowlist + catalog countries) rides the create (task.5405).
 * Side-effects: none
 */

import { COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS } from "@cogni/repo-spec";
import { describe, expect, it } from "vitest";

import type {
  BuiltImageResolverPort,
  NodeCatalogPort,
  NodeRuntimeSecretsPort,
  WorkloadKey,
} from "@/ports";
import { BuiltImageRegistryError, NodeRuntimeSecretsError } from "@/ports";

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
    // the node's isolated migration DSN, read from its `-database-migration` bucket (task.5408)
    DATABASE_MIGRATION_URL: "value-of-DATABASE_MIGRATION_URL",
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
  const runtime = {
    secrets: runtimeSecrets,
    catalog,
    substrateHost: SUBSTRATE,
    operatorDomain: "operator.example",
  };
  const seq = new NodeDeploySequencer({
    store,
    payer,
    edge: new EdgeRouter(dns, edgeHostRegexFor(["poly", "toks5"])),
    probe,
    secrets,
    runtime,
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
    runtime,
    events,
    catalog,
    images,
    clock,
    log,
    seq,
    key,
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
      operatorDomain: "operator.example",
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

  it("adopts an ambiguous paid effect even when the issuer becomes invalid", async () => {
    const h = harness();
    await stateUp(h, POLY_ID);
    h.payer.loseResponseOn = (n) => n === 2;
    h.payer.observeThrows = true;
    await releaseApp(h, POLY_ID);
    expect(h.payer.byDseq("1002").state).toBe("active");
    h.runtime.operatorDomain = "";
    h.payer.observeThrows = false;
    await h.seq.step(h.key(POLY_ID, "canary"));
    const attempt = (await h.store.attemptsFor(h.key(POLY_ID, "canary")))[0];
    expect(attempt?.externalName).toBe("1002");
    expect(h.payer.byDseq("1002").state).toBe("active");
    expect(appCreates(h)).toHaveLength(1);
    expect(
      h.events.filter((event) => event.startsWith("payer.delete:"))
    ).toEqual([]);
  });

  it("does not create a fresh app when issuer configuration is invalid", async () => {
    const h = harness();
    h.runtime.operatorDomain = "";
    await h.store.recordRelease({
      nodeId: POLY_ID,
      env: ENV,
      workload: "canary",
      sourceSha: SHA_1,
      spec: canaryApp({
        secretKeys: DECLARED,
        bindings: [],
        expose: { http: { host: POLY_HOST } },
      }),
      createdBy: "test",
    });
    await h.seq.step(h.key(POLY_ID, "canary"));
    expect(appCreates(h)).toHaveLength(0);
  });

  it("protects the issuer in the final paid payload from declared env and bucket values", async () => {
    const h = harness();
    h.runtimeSecrets.bucket.DOMAIN = "bucket-attacker.example";
    await h.store.recordRelease({
      nodeId: POLY_ID,
      env: ENV,
      workload: "canary",
      sourceSha: SHA_1,
      spec: canaryApp({
        secretKeys: [...DECLARED, "DOMAIN"],
        env: { DOMAIN: "declared-attacker.example" },
        bindings: [],
        expose: { http: { host: POLY_HOST } },
      }),
      createdBy: "test",
    });
    await h.seq.step(h.key(POLY_ID, "canary"));
    expect(h.runtimeSecrets.reads.at(-1)?.keys).toContain("DOMAIN");
    expect(appCreates(h)[0]?.spec.services[0]?.env?.DOMAIN).toBe(
      "operator.example"
    );
  });

  it("refuses a state binding targeting DOMAIN before paying", async () => {
    const h = harness();
    await h.store.recordRelease({
      nodeId: POLY_ID,
      env: ENV,
      workload: "canary",
      sourceSha: SHA_1,
      spec: canaryApp({
        secretKeys: DECLARED,
        bindings: [{ env: "DOMAIN", workload: "canary-db" }],
        expose: { http: { host: POLY_HOST } },
      }),
      createdBy: "test",
    });
    expect(await h.seq.step(h.key(POLY_ID, "canary"))).toBe(
      "waiting_dependency"
    );
    expect(appCreates(h)).toHaveLength(0);
    expect(JSON.stringify(h.log.lines)).toContain("DOMAIN is reserved");
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

describe("green migrates itself before it serves (task.5408)", () => {
  it("a node app with no bound DATABASE_URL gets its migration DSN and a start command that migrates, then execs the app", async () => {
    const h = harness();
    await recordPending(h, SHA_1);
    h.images.published.set(SHA_1, POLY_DIGEST);
    expect(await h.seq.step(h.key(POLY_ID, "canary"))).toBe("driven");
    expect(h.runtimeSecrets.reads.at(-1)?.keys).toContain(
      "DATABASE_MIGRATION_URL"
    );
    const svc = appCreates(h)[0]?.spec.services[0];
    expect(svc?.env?.DATABASE_MIGRATION_URL).toBe(
      "value-of-DATABASE_MIGRATION_URL"
    );
    const script = String(svc?.command?.[2]);
    const migrate = script.indexOf(
      "node /app/app/migrate.mjs /app/app/migrations"
    );
    const doltgres = script.indexOf("node /app/app/migrate-doltgres.mjs");
    const unset = script.indexOf("unset DATABASE_MIGRATION_URL");
    const exec = script.indexOf('exec "$@"');
    expect(migrate).toBeGreaterThan(0);
    expect(doltgres).toBeGreaterThan(migrate);
    expect(unset).toBeGreaterThan(doltgres);
    expect(exec).toBeGreaterThan(unset);
  });

  it("a missing migration DSN waits as a dependency: nothing is created (NO_HALF_ENV)", async () => {
    const h = harness();
    delete h.runtimeSecrets.bucket.DATABASE_MIGRATION_URL;
    await recordPending(h, SHA_1);
    h.images.published.set(SHA_1, POLY_DIGEST);
    expect(await h.seq.step(h.key(POLY_ID, "canary"))).toBe(
      "waiting_dependency"
    );
    expect(appCreates(h)).toHaveLength(0);
  });

  it("a node app whose DATABASE_URL is bound to its own state lease migrates THAT database (OWN_STATE_MIGRATES_ITSELF)", async () => {
    const h = harness();
    await stateUp(h, POLY_ID);
    await releaseApp(h, POLY_ID);
    const svc = appCreates(h)[0]?.spec.services[0];
    // The migration DSN is the binding's own DSN, never the shared bucket's.
    expect(svc?.env?.DATABASE_MIGRATION_URL).toBe(svc?.env?.DATABASE_URL);
    expect(svc?.env?.DATABASE_MIGRATION_URL).not.toBe(
      h.runtimeSecrets.bucket.DATABASE_MIGRATION_URL
    );
    expect(String(svc?.command?.[2])).toContain("migrate.mjs");
  });
});
