// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/sequencer-mesh.test`
 * Purpose: Prove the sequencer's mesh lifecycle (task.5431, hub node-service-delivery sections 3, 4, 6)
 *   over a fake Headscale that follows v0.29.7's observed rules: per-attempt transport (HR 18), derived
 *   listeners = grant (HR 3), fail-closed policy before any mint (HR 4), one stored key per attempt across
 *   a lost mint response and restarts (HR 5), expire-then-delete revocation with a retained blue (HR 6),
 *   device health without storms (HR 8), wipe recovery (HR 10), approval with no key compare (HR 11),
 *   no paid create without one online gateway (HR 23), unprivileged pinned companions (HR 16, HR 21),
 *   and no key value in any log or step (HR 14).
 * Scope: The REAL sequencer and MeshPlane over in-memory fakes. No network, no Kubernetes.
 * Invariants: every hard requirement named above has at least one falsifying case here.
 * Side-effects: none
 * Links: sequencer.ts, mesh-attempt.ts, mesh-plane.ts
 */

import { COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS } from "@cogni/repo-spec";
import { describe, expect, it } from "vitest";

import {
  type AttemptRow,
  type CreatePreAuthKeyInput,
  type HeadscaleDeviceId,
  type HeadscaleKeyId,
  type HeadscaleUser,
  headscaleDeviceId,
  headscaleKeyId,
  MESH_ATTEMPT_SECRET_NAME_RE,
  type MeshApiKey,
  type MeshDevice,
  type MeshKeyStorePort,
  type MeshPolicy,
  type MeshPreAuthKey,
  type MeshUser,
  type MintedPreAuthKey,
  type NodeCatalogPort,
  NodeMeshError,
  type NodeMeshPort,
  type NodeRuntimeSecretsPort,
  type PayerCreateRequest,
  PayerError,
  type PublishedSubstrateRequest,
  type StoredMeshKey,
  type SubstrateTransport,
  type WorkloadKey,
} from "@/ports";

import { EdgeRouter, edgeHostRegexFor } from "./edge";
import {
  attemptTransport,
  DEVICE_ABSENT_ROLL_MS,
  deviceRollsInFlight,
  MESH_COMPANION_IMAGES,
  MESH_DEVICE_ABSENT,
  meshCompanionServices,
} from "./mesh-attempt";
import { MESH_SECRET_NAME_PATTERN, MeshPlane } from "./mesh-plane";
import { DEFAULT_SEQUENCER_CONFIG, NodeDeploySequencer } from "./sequencer";
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
  SHA_2,
  WORKLOAD_ZONE,
} from "./testing";

const SUBSTRATE = "cogni.vm.cognidao.org";
const CONTROL = "https://mesh-production.cognidao.org";
const NODES = {
  poly: "4b06359a-0000-4000-8000-0000000000aa",
  toks5: "4b06359a-0000-4000-8000-0000000000bb",
  red: "4b06359a-0000-4000-8000-0000000000cc",
} as const;
type Slug = keyof typeof NODES;
const DECLARED = [...COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS];

// ---------------------------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------------------------

interface FakeKey {
  id: string;
  tags: string[];
  expiration: number;
  createdAt: number;
  key: string;
}

/** Headscale v0.29.7 rules: absent policy is null; expire stamps now; a join with an expired key fails. */
class FakeHeadscale implements NodeMeshPort {
  policy: string | null = null;
  readonly users: string[] = [];
  readonly keys = new Map<string, FakeKey>();
  readonly devices = new Map<string, MeshDevice>();
  readonly pending = new Map<string, { machineKey: string; nodeKey: string }>();
  readonly calls: string[] = [];
  apiKeys: MeshApiKey[] = [];
  down = false;
  loseNextMintResponse = false;
  /** One shot per id: the next DeleteNode of that id fails (the device stays). */
  readonly failDelete = new Set<string>();
  /** Key and device ids restart at 1 on a wipe, like a fresh Headscale database (the B1 hazard). */
  private keySeq = 0;
  private deviceSeq = 0;
  readonly userCreatedAt = new Map<string, string>();
  constructor(private readonly clock: FakeClock) {}

  private enter(method: string): void {
    this.calls.push(method);
    if (this.down) throw new NodeMeshError(method, "unavailable", "other");
  }
  private iso(t: number): string {
    return new Date(t).toISOString();
  }
  private view(k: FakeKey): MeshPreAuthKey {
    return {
      headscaleKeyId: headscaleKeyId(k.id),
      tags: [...k.tags],
      reusable: true,
      ephemeral: true,
      used: false,
      expiration: this.iso(k.expiration),
      createdAt: this.iso(k.createdAt),
    };
  }
  async health() {
    this.enter("Health");
    return { databaseConnectivity: true };
  }
  async getPolicy(): Promise<MeshPolicy | null> {
    this.enter("GetPolicy");
    return this.policy === null
      ? null
      : { policy: this.policy, updatedAt: null };
  }
  async setPolicy(policy: string): Promise<MeshPolicy> {
    this.enter(`SetPolicy:${JSON.parse(policy).acls.length}`);
    this.policy = policy;
    return { policy, updatedAt: null };
  }
  async createUser(name: HeadscaleUser): Promise<MeshUser> {
    this.enter("CreateUser");
    this.users.push(name);
    const createdAt = new Date(this.clock.now()).toISOString();
    this.userCreatedAt.set(name, createdAt);
    return { headscaleUser: name, createdAt };
  }
  async listUsers(): Promise<readonly MeshUser[]> {
    this.enter("ListUsers");
    return this.users.map((u) => ({
      headscaleUser: u as HeadscaleUser,
      createdAt: this.userCreatedAt.get(u) ?? null,
    }));
  }
  async createPreAuthKey(
    input: CreatePreAuthKeyInput
  ): Promise<MintedPreAuthKey> {
    this.enter("CreatePreAuthKey");
    const id = String(++this.keySeq);
    const k: FakeKey = {
      id,
      tags: [...input.tags],
      expiration: input.expiration.getTime(),
      createdAt: this.clock.now(),
      key: `hskey-auth-${id}-secret`,
    };
    this.keys.set(id, k);
    if (this.loseNextMintResponse) {
      this.loseNextMintResponse = false;
      throw new NodeMeshError("CreatePreAuthKey", "timeout", "other");
    }
    return { ...this.view(k), key: k.key };
  }
  async expirePreAuthKey(id: HeadscaleKeyId): Promise<void> {
    this.enter(`ExpirePreAuthKey:${id}`);
    const k = this.keys.get(id);
    if (k) k.expiration = this.clock.now();
  }
  async listPreAuthKeys(): Promise<readonly MeshPreAuthKey[]> {
    this.enter("ListPreAuthKeys");
    return [...this.keys.values()].map((k) => this.view(k));
  }
  async listNodes(): Promise<readonly MeshDevice[]> {
    this.enter("ListNodes");
    return [...this.devices.values()];
  }
  async deleteNode(id: HeadscaleDeviceId): Promise<void> {
    this.enter(`DeleteNode:${id}`);
    if (this.failDelete.delete(id))
      throw new NodeMeshError("DeleteNode", "unavailable", "other");
    if (!this.devices.delete(id))
      throw new NodeMeshError("DeleteNode", "not_found", "node_not_found");
  }
  async authRegister(input: {
    headscaleUser: HeadscaleUser;
    authId: string;
  }): Promise<MeshDevice> {
    this.enter("AuthRegister");
    const p = this.pending.get(input.authId);
    if (!p)
      throw new NodeMeshError(
        "AuthRegister",
        "not_found",
        "registration_not_found"
      );
    this.pending.delete(input.authId);
    return this.addGateway(p.machineKey, p.nodeKey);
  }
  async listApiKeys(): Promise<readonly MeshApiKey[]> {
    this.enter("ListApiKeys");
    return this.apiKeys;
  }

  // -- test hooks --
  addGateway(machineKey = "mkey:gw", nodeKey = "nodekey:gw"): MeshDevice {
    const id = String(++this.deviceSeq);
    const d: MeshDevice = {
      headscaleDeviceId: headscaleDeviceId(id),
      name: "substrate-gw",
      givenName: "substrate-gw",
      machineKey,
      nodeKey,
      tags: ["tag:substrate"],
      online: true,
      headscaleKeyId: null,
      headscaleUser: null,
      createdAt: this.iso(this.clock.now()),
      lastSeen: null,
      expiry: null,
    };
    this.devices.set(id, d);
    return d;
  }
  /** A companion joins with an attempt key; an expired key is refused (`authkey expired`). */
  join(key: string, name: string): MeshDevice {
    const k = [...this.keys.values()].find((x) => x.key === key);
    if (!k) throw new Error("unknown key");
    if (k.expiration <= this.clock.now())
      throw new NodeMeshError("Register", "unknown", "authkey_expired");
    const id = String(++this.deviceSeq);
    const d: MeshDevice = {
      headscaleDeviceId: headscaleDeviceId(id),
      name,
      givenName: name,
      machineKey: `mkey:${id}`,
      nodeKey: `nodekey:${id}`,
      tags: [...k.tags],
      online: true,
      headscaleKeyId: headscaleKeyId(k.id),
      headscaleUser: null,
      createdAt: this.iso(this.clock.now()),
      lastSeen: null,
      expiry: null,
    };
    this.devices.set(id, d);
    return d;
  }
  devicesOf(keyId: string | undefined): MeshDevice[] {
    return [...this.devices.values()].filter((d) => d.headscaleKeyId === keyId);
  }
  expired(keyId: string | undefined): boolean {
    const k = keyId ? this.keys.get(keyId) : undefined;
    return !!k && k.expiration <= this.clock.now();
  }
  /** The Headscale volume is lost: no policy, no user, no key, no device. */
  wipe(): void {
    this.policy = null;
    this.users.length = 0;
    this.userCreatedAt.clear();
    this.keys.clear();
    this.devices.clear();
    this.keySeq = 0;
    this.deviceSeq = 0;
  }
}

class MemoryMeshKeys implements MeshKeyStorePort {
  readonly secrets = new Map<string, StoredMeshKey>();
  readonly deleted: string[] = [];
  /** The write lands but its response is lost. */
  loseNextCreateResponse = false;
  constructor(private readonly events: string[]) {}
  async get(name: string): Promise<StoredMeshKey | undefined> {
    expect(MESH_ATTEMPT_SECRET_NAME_RE.test(name)).toBe(true);
    return this.secrets.get(name);
  }
  async createOnce(name: string, value: StoredMeshKey) {
    const winner = this.secrets.get(name);
    if (winner) return winner;
    this.secrets.set(name, value);
    this.events.push(`secret.create:${name}`);
    if (this.loseNextCreateResponse) {
      this.loseNextCreateResponse = false;
      throw new Error("apiserver response lost");
    }
    return value;
  }
  async delete(name: string): Promise<void> {
    this.secrets.delete(name);
    this.deleted.push(name);
  }
}

class FakeRuntimeSecrets implements NodeRuntimeSecretsPort {
  bucket: Record<string, string> = {
    ...Object.fromEntries(DECLARED.map((k) => [k, `value-of-${k}`])),
    // Poly's Postgres is its own cell (not the VM): it must never become a grant or a listener.
    DATABASE_URL: "postgresql://poly@poly-db.cell.example:5432/poly",
    DATABASE_SERVICE_URL:
      "postgresql://poly_service:pw@poly-db.cell.example:5432/poly",
    DOLTGRES_URL: `postgresql://dolt@${SUBSTRATE}:5435/knowledge`,
    DATABASE_MIGRATION_URL: "postgresql://m@poly-db.cell.example:5432/poly",
  };
  async read(_env: string, _slug: string, keys: readonly string[]) {
    return Object.fromEntries(keys.map((k) => [k, this.bucket[k] ?? "x"]));
  }
}

class FakeCatalog implements NodeCatalogPort {
  async slugs() {
    return Object.keys(NODES);
  }
  async entryFor(nodeId: string) {
    const slug = (Object.keys(NODES) as Slug[]).find(
      (s) => NODES[s] === nodeId
    );
    return slug ? { slug, row: { name: slug } } : undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

/** The probe's DNS path for the lane VM host (task.5432 SHARED_POSTGRES_ONLY). */
class ResolvingProbe extends FakeProbe {
  addresses: readonly string[] | "fail" = [];
  async resolveAddresses(_host: string): Promise<readonly string[]> {
    if (this.addresses === "fail") throw new Error("SERVFAIL");
    return this.addresses;
  }
}

function harness(
  opts: {
    readonly bucket?: Record<string, string>;
    readonly addresses?: readonly string[] | "fail";
  } = {}
) {
  const events: string[] = [];
  const clock = new FakeClock();
  const store = new MemoryStore(clock);
  const payer = new FakePayer(events);
  const dns = new FakeDns(events);
  const probe = new ResolvingProbe(payer, dns, events);
  probe.addresses = opts.addresses ?? [];
  const runtimeSecrets = new FakeRuntimeSecrets();
  Object.assign(runtimeSecrets.bucket, opts.bucket ?? {});
  const hs = new FakeHeadscale(clock);
  const keys = new MemoryMeshKeys(events);
  const log = new MemoryLog();
  const published: { request: PublishedSubstrateRequest | null } = {
    request: null,
  };
  hs.addGateway();
  const edge = new EdgeRouter(
    dns,
    WORKLOAD_ZONE,
    edgeHostRegexFor(Object.keys(NODES), WORKLOAD_ZONE)
  );
  const build = (mesh: "mint" | "drain" | false = "mint") =>
    new NodeDeploySequencer({
      store,
      payer,
      edge,
      probe,
      secrets: new MemorySecrets(),
      runtime: {
        secrets: runtimeSecrets,
        catalog: new FakeCatalog(),
        substrateHost: SUBSTRATE,
        operatorDomain: "operator.example",
      },
      ...(mesh
        ? {
            mesh: {
              mode: mesh,
              plane: new MeshPlane(hs, ENV),
              keys,
              substrateRequests: { read: async () => published.request },
              controlUrl: CONTROL,
            },
          }
        : {}),
      chain: new FakeChain(payer),
      clock,
      log,
      config: {
        ...DEFAULT_SEQUENCER_CONFIG,
        namespace: "cogni-production",
        environment: ENV,
        retainMs: 120_000,
        publicStreak: 1, // bug.5587: one public read per tick; sequencer.test.ts tests the 8-read streak
      },
    });
  let seq = build();
  // Every mesh lease's companion joins with the key its create carried (as `containerboot` does).
  let autoJoin = true;
  payer.onLease = () => {
    const companion = meshOf(payer.createRequests.at(-1));
    if (autoJoin && companion?.env?.TS_AUTHKEY)
      hs.join(companion.env.TS_AUTHKEY, companion.env.TS_HOSTNAME ?? "x");
  };
  const key = (slug: Slug): WorkloadKey => ({
    nodeId: NODES[slug],
    env: ENV,
    workload: "app",
  });
  const release = (slug: Slug, sha = SHA_1) =>
    store.recordRelease({
      ...key(slug),
      sourceSha: sha,
      spec: canaryApp({
        name: "app",
        bindings: [],
        secretKeys: DECLARED,
        expose: { http: { host: `${slug}.cognidao.org` } },
      }),
      createdBy: "test",
    });
  const attempts = async (slug: Slug) => store.attemptsFor(key(slug));
  /** One reconcile pass per minute for `minutes` minutes. */
  const passes = async (minutes: number) => {
    for (let i = 0; i < minutes; i++) {
      clock.advance(60_000);
      await seq.reconcileAll();
    }
  };
  return {
    events,
    clock,
    store,
    payer,
    hs,
    keys,
    log,
    published,
    key,
    release,
    attempts,
    passes,
    get seq() {
      return seq;
    },
    restart(mesh: "mint" | "drain" | false = "mint") {
      seq = build(mesh);
    },
    setAutoJoin(on: boolean) {
      autoJoin = on;
    },
  };
}
type H = ReturnType<typeof harness>;

const meshOf = (req: PayerCreateRequest | undefined) =>
  req?.spec.services.find((s) => s.name === "cogni-mesh");
const substrateOf = (req: PayerCreateRequest | undefined) =>
  req?.spec.services.find((s) => s.name === "cogni-substrate");
const appCreates = (h: H) =>
  h.payer.createRequests.filter((r) => r.spec.name === "app");
const meshLogs = (h: H, msg: string) =>
  h.log.lines.filter((l) => l.msg === msg);

/** bug.5587: a step probes a proof ONCE; step `pollMs` apart until the attempt leaves `proving`. */
async function stepUntilProved(h: H, slug: Slug): Promise<void> {
  for (let i = 0; i < 10_000; i++) {
    await h.seq.step(h.key(slug));
    if ((await h.attempts(slug))[0]?.phase !== "proving") return;
    h.clock.advance(DEFAULT_SEQUENCER_CONFIG.pollMs);
  }
  throw new Error(`${slug} still proving`);
}

/** Open minting (first pass), then deploy one release of `slug` to active. */
async function deployed(h: H, slug: Slug, sha = SHA_1): Promise<AttemptRow> {
  await h.seq.reconcileAll();
  await h.release(slug, sha);
  expect(await h.seq.step(h.key(slug))).toBe("driven");
  const active = (await h.attempts(slug)).find((a) => a.phase === "active");
  if (!active)
    throw new Error(
      `no active attempt: ${h.log.steps().join(" ")} ${(await h.attempts(slug)).map((a) => a.error).join(";")}`
    );
  return active;
}

// ---------------------------------------------------------------------------------------------
// HR 18: transport per attempt
// ---------------------------------------------------------------------------------------------

const row = (
  phase: AttemptRow["phase"],
  transport: SubstrateTransport | undefined,
  releaseId = "r-old"
): AttemptRow => ({
  id: `${phase}-${transport}-${releaseId}`,
  releaseId,
  attempt: 1,
  cogniKey: "k",
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
  ...(transport ? { transport } : {}),
});

describe("HR 18: a lane switch never leaves a node without a serving path", () => {
  const t = (
    over: Partial<Parameters<typeof attemptTransport>[0]>
  ): SubstrateTransport =>
    attemptTransport({
      lane: "mesh",
      blueRetained: false,
      releaseId: "r-new",
      workloadAttempts: [],
      nodeAttempts: [],
      ...over,
    });

  it("decides each case of the rule", () => {
    // an egress lane is always egress
    expect(t({ lane: "egress", blueRetained: true })).toBe("egress");
    // a retained blue is behind the first mesh attempt (CD6)
    const blue = row("active", "egress");
    expect(
      t({ blueRetained: true, workloadAttempts: [blue], nodeAttempts: [blue] })
    ).toBe("mesh");
    // a new release of a workload that serves nowhere (Poly production today)
    const failed = row("failed", "egress");
    expect(t({ workloadAttempts: [failed], nodeAttempts: [failed] })).toBe(
      "mesh"
    );
    // blue served but is not retained -> the served transport (egress)
    expect(t({ workloadAttempts: [blue], nodeAttempts: [blue] })).toBe(
      "egress"
    );
    // lost-lease redeploy of a never-meshed node keeps egress
    const lost = row("lost", "egress", "r-new");
    expect(t({ workloadAttempts: [lost], nodeAttempts: [lost] })).toBe(
      "egress"
    );
    // a legacy attempt with no recorded transport is egress
    const legacy = row("lost", undefined, "r-new");
    expect(t({ workloadAttempts: [legacy], nodeAttempts: [legacy] })).toBe(
      "egress"
    );
    // a node that served on the mesh before keeps the mesh, also on a lost-lease redeploy
    const meshLost = row("lost", "mesh", "r-new");
    expect(t({ workloadAttempts: [meshLost], nodeAttempts: [meshLost] })).toBe(
      "mesh"
    );
  });

  it("records the transport on the attempt row: a meshed node's lost lease redeploys on the mesh", async () => {
    const h = harness();
    const first = await deployed(h, "poly");
    expect(first.transport).toBe("mesh");
    h.payer.byDseq(first.externalName ?? "").state = "closed";
    await h.passes(1);
    expect(await h.seq.step(h.key("poly"))).toBe("driven");
    const [redeploy, lost] = await h.attempts("poly");
    expect(lost?.phase).toBe("lost");
    expect(redeploy?.phase).toBe("active");
    expect(redeploy?.transport).toBe("mesh");
  });

  it("a never-meshed node's lost-lease redeploy stays egress after the lane switches; its next release with a blue moves", async () => {
    const h = harness();
    h.restart(false); // egress lane, no mesh deps
    await h.release("poly");
    await h.seq.step(h.key("poly"));
    const egress = (await h.attempts("poly"))[0];
    expect(egress?.phase).toBe("active");
    expect(egress?.transport).toBe("egress");
    expect(meshOf(appCreates(h)[0])).toBeUndefined();

    h.restart("mint"); // the lane switches to mesh
    await h.seq.reconcileAll();
    h.payer.byDseq(egress?.externalName ?? "").state = "closed";
    await h.passes(1);
    await h.seq.step(h.key("poly"));
    const redeploy = (await h.attempts("poly"))[0];
    expect(redeploy?.phase).toBe("active");
    expect(redeploy?.transport).toBe("egress");
    expect(meshOf(appCreates(h)[1])).toBeUndefined();

    // A new release with a serving blue moves to the mesh; blue keeps serving until green proves.
    await h.release("poly", SHA_2);
    await h.seq.step(h.key("poly"));
    const [green, blue] = await h.attempts("poly");
    expect(green?.transport).toBe("mesh");
    expect(green?.phase).toBe("active");
    expect(blue?.phase).toBe("retiring");
  });
});

// ---------------------------------------------------------------------------------------------
// HR 3, HR 16, HR 21: derived listeners, pinned unprivileged companions
// ---------------------------------------------------------------------------------------------

describe("HR 3, 16, 21: the companions carry exactly the derived ports", () => {
  const SHARED_PG = "postgresql://poly@203.0.113.7:5432/poly";

  it("a bucket Postgres DSN on the VM's resolved address is rebound and granted 5432; a failed lookup rebinds nothing", async () => {
    const sharedBucket = {
      DATABASE_URL: SHARED_PG,
      DATABASE_SERVICE_URL:
        "postgresql://poly_service:pw@203.0.113.7:5432/poly",
      DATABASE_MIGRATION_URL: "postgresql://m:pw@203.0.113.7:5432/poly",
    };
    const shared = harness({
      bucket: sharedBucket,
      addresses: ["203.0.113.7"],
    });
    const a = await deployed(shared, "poly");
    expect(a.mesh?.ports).toEqual([4000, 5432, 5435, 6379, 7233, 30900]);
    const app = appCreates(shared)[0]?.spec.services[0];
    expect(app?.env?.DATABASE_URL).toContain("@cogni-substrate:5432/");
    expect(
      substrateOf(appCreates(shared)[0])?.expose?.map((e) => e.port)
    ).toEqual(a.mesh?.ports);

    const unresolved = harness({
      bucket: sharedBucket,
      addresses: "fail",
    });
    const b = await deployed(unresolved, "poly");
    expect(b.mesh?.ports).toEqual([4000, 5435, 6379, 7233, 30900]);
    expect(appCreates(unresolved)[0]?.spec.services[0]?.env?.DATABASE_URL).toBe(
      SHARED_PG
    );
  });

  it("listeners = attempt ports = policy grant; the app's substrate host is cogni-substrate", async () => {
    const h = harness();
    const a = await deployed(h, "poly");
    const req = appCreates(h)[0];
    const app = req?.spec.services[0];
    expect(app?.env?.TEMPORAL_ADDRESS).toBe("cogni-substrate:7233");
    expect(app?.env?.REDIS_URL).toBe("redis://cogni-substrate:6379");
    expect(app?.env?.LITELLM_BASE_URL).toBe("http://cogni-substrate:4000");
    // Poly's own Postgres cell (5432 elsewhere) is not a grant; the VM Doltgres (5435) is.
    expect(a.mesh?.ports).toEqual([4000, 5435, 6379, 7233, 30900]);
    expect(substrateOf(req)?.expose?.map((e) => e.port)).toEqual(a.mesh?.ports);
    const policy = JSON.parse(h.hs.policy ?? "{}") as {
      acls: { src: string[]; dst: string[] }[];
    };
    expect(policy.acls).toEqual([
      {
        action: "accept",
        proto: "tcp",
        src: [`tag:node-${NODES.poly}`],
        dst: ["tag:substrate:4000,5435,6379,7233,30900"],
      },
    ]);
    // The scheduler-worker health port is a reviewed registry row (task.5432): bound like the rest.
    expect(app?.env?.SCHEDULER_WORKER_HEALTH_URL).toBe(
      "http://cogni-substrate:30900"
    );
    // Doltgres moves to the companion; Poly's own Postgres cell keeps its endpoint.
    expect(app?.env?.DOLTGRES_URL).toContain("@cogni-substrate:5435/");
    expect(app?.env?.DATABASE_URL).toContain("@poly-db.cell.example:5432/");
  });

  it("companions: uid 10001, no capability, no --advertise-tags, no Tailscale logs, our control URL, pinned digests, lease-internal only", async () => {
    const h = harness();
    await deployed(h, "poly");
    const req = appCreates(h)[0];
    const mesh = meshOf(req);
    const substrate = substrateOf(req);
    expect(mesh?.image).toBe(MESH_COMPANION_IMAGES.mesh);
    expect(substrate?.image).toBe(MESH_COMPANION_IMAGES.substrate);
    expect(mesh?.image).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(substrate?.image).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(mesh?.env?.TS_EXTRA_ARGS).toBe(`--login-server=${CONTROL}`);
    expect(JSON.stringify(mesh)).not.toContain("advertise-tags");
    expect(mesh?.env?.TS_NO_LOGS_NO_SUPPORT).toBe("true");
    expect(mesh?.env?.TS_USERSPACE).toBe("true");
    expect(mesh?.env?.TS_STATE_DIR).toBeUndefined();
    // CD9: no `unset` logic; the env override keeps containerboot off the kube Secret path.
    expect(mesh?.env?.KUBERNETES_SERVICE_HOST).toBe("");
    expect(mesh?.args).toEqual([
      "adduser -D -H -u 10001 cogni && exec su -p -s /bin/sh cogni -c 'exec /usr/local/bin/containerboot'",
    ]);
    for (const svc of [mesh, substrate]) {
      expect(svc?.args?.join("\n")).toContain("-u 10001");
      expect(svc?.args?.join("\n")).toContain("exec su -p -s /bin/sh cogni");
      expect(svc?.expose?.every((e) => e.global === false)).toBe(true);
    }
    expect(substrate?.args?.join("\n")).toContain(
      "SOCKS5-CONNECT:cogni-mesh:1055:substrate-gw.mesh.cogni:5435"
    );
    expect(() =>
      meshCompanionServices({
        authKey: "k",
        controlUrl: "http://mesh.example:8080",
        deviceName: "d",
        ports: [5435],
        images: MESH_COMPANION_IMAGES,
      })
    ).toThrow(/https/);
    expect(() =>
      meshCompanionServices({
        authKey: "k",
        controlUrl: CONTROL,
        deviceName: "d",
        ports: [22],
        images: MESH_COMPANION_IMAGES,
      })
    ).toThrow(/not a substrate port/);
  });

  it("CD3: every attempt of one release uses the companion digests its first mesh attempt pinned", async () => {
    const h = harness();
    await h.seq.reconcileAll();
    h.payer.onLease = (l) => {
      l.notReady = true; // attempt 1 fails its proof
    };
    await h.release("poly");
    await stepUntilProved(h, "poly");
    const [first] = await h.attempts("poly");
    expect(first?.phase).toBe("failed");
    const pinned = {
      mesh: `tailscale/tailscale@sha256:${"1".repeat(64)}`,
      substrate: `alpine/socat@sha256:${"2".repeat(64)}`,
    };
    await h.store.updateAttempt(first?.id ?? "", {
      mesh: {
        ...(first?.mesh as NonNullable<AttemptRow["mesh"]>),
        images: pinned,
      },
    });
    h.payer.onLease = undefined;
    await h.seq.step(h.key("poly"));
    const second = appCreates(h)[1];
    expect(meshOf(second)?.image).toBe(pinned.mesh);
    expect(substrateOf(second)?.image).toBe(pinned.substrate);
  });
});

// ---------------------------------------------------------------------------------------------
// HR 4, HR 5, HR 14: fail closed, one stored key per attempt
// ---------------------------------------------------------------------------------------------

describe("HR 4, 5, 14: no key before a matched policy; one stored key per attempt", () => {
  it("before the first pass no mesh attempt starts; a fresh Headscale is seeded deny-all before any mint", async () => {
    const h = harness();
    await h.release("poly");
    expect(await h.seq.step(h.key("poly"))).toBe("waiting_dependency");
    expect(await h.attempts("poly")).toHaveLength(0);
    expect(h.payer.createRequests).toHaveLength(0);
    expect(h.log.steps()).toContain("dependency:waiting");

    await h.seq.reconcileAll();
    // `SetPolicy:<acl count>`: deny-all (0 rules) is written before anything else is written.
    expect(h.hs.calls.filter((c) => c.startsWith("SetPolicy"))[0]).toBe(
      "SetPolicy:0"
    );
    expect(h.hs.calls).not.toContain("CreatePreAuthKey");
    await h.seq.step(h.key("poly"));
    const firstMint = h.hs.calls.indexOf("CreatePreAuthKey");
    expect(firstMint).toBeGreaterThan(h.hs.calls.indexOf("SetPolicy:0"));
    expect((await h.attempts("poly"))[0]?.phase).toBe("active");
  });

  it("the attempt Secret names are exactly the port's (and the admission policy's) delete allow-list", () => {
    expect(MESH_SECRET_NAME_PATTERN.source).toBe(
      MESH_ATTEMPT_SECRET_NAME_RE.source
    );
  });

  it("the key id is on the row and the value in a create-once Secret before the paid create", async () => {
    const h = harness();
    const a = await deployed(h, "poly");
    const name = [...h.keys.secrets.keys()][0] ?? "";
    expect(MESH_SECRET_NAME_PATTERN.test(name)).toBe(true);
    expect(name).toContain(`-app-mesh-${a.releaseId}-a1`);
    const stored = h.keys.secrets.get(name);
    expect(stored?.headscaleKeyId).toBe(a.mesh?.headscaleKeyId);
    expect(meshOf(appCreates(h)[0])?.env?.TS_AUTHKEY).toBe(stored?.key);
    expect(h.events.indexOf(`secret.create:${name}`)).toBeLessThan(
      h.events.findIndex((e) => e.startsWith("payer.create"))
    );
    // HR 14: the key value is in no log line and no persisted step.
    const value = stored?.key ?? "missing";
    expect(JSON.stringify(h.log.lines)).not.toContain(value);
    expect(JSON.stringify(h.store.attempts)).not.toContain(value);
  });

  it("restart-mid-mint: a lost mint response and a restart make one stored key, one create, and the unstored key expired", async () => {
    const h = harness();
    await h.seq.reconcileAll();
    h.hs.loseNextMintResponse = true;
    await h.release("poly");
    await h.seq.step(h.key("poly"));
    const [pending] = await h.attempts("poly");
    expect(pending?.phase).toBe("planned");
    expect(pending?.error).toMatch(/^mesh_key_pending: mint_/);
    expect(h.payer.createRequests).toHaveLength(0);
    const orphan = [...h.hs.keys.keys()][0];

    h.restart();
    // The new process must sweep before it mints (SWEEP_BEFORE_MINT): still pending, still unpaid.
    await h.seq.step(h.key("poly"));
    expect((await h.attempts("poly"))[0]?.error).toMatch(/sweep_pending/);
    expect(h.payer.observeCalls).toBe(0); // never dispatched, so never observed
    await h.seq.reconcileAll();
    await h.seq.step(h.key("poly"));
    const [a] = await h.attempts("poly");
    expect(a?.id).toBe(pending?.id); // the SAME attempt: no burned ordinal
    expect(a?.phase).toBe("active");
    await h.passes(2);
    expect(h.keys.secrets.size).toBe(1);
    expect(appCreates(h)).toHaveLength(1);
    expect(h.hs.expired(orphan)).toBe(true);
    expect(h.hs.expired(a?.mesh?.headscaleKeyId)).toBe(false);
  });

  it("a lost Secret-write response reuses the stored key on the next tick: no second mint", async () => {
    const h = harness();
    await h.seq.reconcileAll();
    h.keys.loseNextCreateResponse = true;
    await h.release("poly");
    await h.seq.step(h.key("poly"));
    expect((await h.attempts("poly"))[0]?.error).toBe(
      "mesh_key_pending: key_store_unavailable"
    );
    await h.seq.step(h.key("poly"));
    const [a] = await h.attempts("poly");
    expect(a?.phase).toBe("active");
    expect(h.hs.calls.filter((c) => c === "CreatePreAuthKey")).toHaveLength(1);
    expect(meshOf(appCreates(h)[0])?.env?.TS_AUTHKEY).toBe(
      [...h.keys.secrets.values()][0]?.key
    );
  });

  it("release 2 attempt 1 gets a new Secret and a new key id, not release 1's", async () => {
    const h = harness();
    const r1 = await deployed(h, "poly");
    await h.release("poly", SHA_2);
    await h.seq.step(h.key("poly"));
    const [r2] = await h.attempts("poly");
    expect(r2?.attempt).toBe(1);
    expect(r2?.releaseId).not.toBe(r1.releaseId);
    expect(r2?.mesh?.headscaleKeyId).not.toBe(r1.mesh?.headscaleKeyId);
    expect(h.keys.secrets.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------
// HR 6: revocation
// ---------------------------------------------------------------------------------------------

describe("HR 6: revoke on close; a blue is revoked only after it retires", () => {
  it("a failed attempt's key is expired and its devices deleted in the next pass; its Secret goes one pass later", async () => {
    const h = harness();
    await h.seq.reconcileAll();
    h.payer.onLease = (l) => {
      const c = meshOf(h.payer.createRequests.at(-1));
      h.hs.join(c?.env?.TS_AUTHKEY ?? "", "x");
      l.notReady = true;
    };
    await h.release("poly");
    await stepUntilProved(h, "poly");
    const [failed] = await h.attempts("poly");
    expect(failed?.phase).toBe("failed");
    const keyId = failed?.mesh?.headscaleKeyId;
    expect(h.hs.devicesOf(keyId)).toHaveLength(1);
    await h.passes(1);
    expect(h.hs.expired(keyId)).toBe(true);
    expect(h.hs.devicesOf(keyId)).toHaveLength(0);
    const revoked = (await h.attempts("poly"))[0];
    expect(revoked?.mesh?.revokedAt).toBeDefined();
    expect(h.keys.secrets.size).toBe(1); // not in the same pass
    // A re-join with the revoked key is refused.
    const value = [...h.keys.secrets.values()][0]?.key ?? "";
    expect(() => h.hs.join(value, "again")).toThrow(/authkey_expired/);
    await h.passes(1);
    expect(h.keys.secrets.size).toBe(0);
    expect((await h.attempts("poly"))[0]?.mesh?.secretDeletedAt).toBeDefined();
  });

  it("a retiring blue keeps its key and device during the retain window; after it retires it is revoked", async () => {
    const h = harness();
    const blue = await deployed(h, "poly");
    await h.release("poly", SHA_2);
    await h.seq.step(h.key("poly"));
    const retiring = (await h.attempts("poly")).find((a) => a.id === blue.id);
    expect(retiring?.phase).toBe("retiring");
    await h.passes(1);
    expect(h.hs.expired(blue.mesh?.headscaleKeyId)).toBe(false);
    expect(h.hs.devicesOf(blue.mesh?.headscaleKeyId)).toHaveLength(1);
    h.clock.advance(120_000);
    await h.seq.step(h.key("poly")); // janitor retires blue
    await h.passes(1);
    expect(
      (await h.attempts("poly")).find((a) => a.id === blue.id)?.phase
    ).toBe("retired");
    expect(h.hs.expired(blue.mesh?.headscaleKeyId)).toBe(true);
    expect(h.hs.devicesOf(blue.mesh?.headscaleKeyId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// HR 7, HR 8: device health without storms; clone alert
// ---------------------------------------------------------------------------------------------

const rolls = (h: H) => meshLogs(h, "node_mesh_device_roll").length;

describe("HR 7, 8: device check", () => {
  it("a deleted live device rolls exactly one new attempt after 10 minutes of successful reads", async () => {
    const h = harness();
    const a = await deployed(h, "poly");
    for (const d of h.hs.devicesOf(a.mesh?.headscaleKeyId))
      h.hs.devices.delete(d.headscaleDeviceId);
    await h.passes(DEVICE_ABSENT_ROLL_MS / 60_000 - 1);
    expect(rolls(h)).toBe(0);
    await h.passes(2);
    expect(rolls(h)).toBe(1);
    const lost = (await h.attempts("poly")).find((x) => x.id === a.id);
    expect(lost?.phase).toBe("lost");
    expect(lost?.error).toBe(MESH_DEVICE_ABSENT);
    await h.seq.step(h.key("poly"));
    const [next] = await h.attempts("poly");
    expect(next?.phase).toBe("active");
    expect(next?.transport).toBe("mesh");
    await h.passes(15);
    expect(rolls(h)).toBe(1);
  });

  it("ephemeral restarts: any online device of the key counts, offline leftovers do not roll", async () => {
    const h = harness();
    const a = await deployed(h, "poly");
    const [first] = h.hs.devicesOf(a.mesh?.headscaleKeyId);
    h.hs.devices.set(first?.headscaleDeviceId ?? "", {
      ...(first as MeshDevice),
      online: false,
    });
    h.hs.join(meshOf(appCreates(h)[0])?.env?.TS_AUTHKEY ?? "", "restart-2");
    await h.passes(15);
    expect(rolls(h)).toBe(0);
  });

  it("failed reads roll nothing: 30 minutes of a down Headscale, then the count restarts", async () => {
    const h = harness();
    const a = await deployed(h, "poly");
    for (const d of h.hs.devicesOf(a.mesh?.headscaleKeyId))
      h.hs.devices.delete(d.headscaleDeviceId);
    await h.passes(5);
    h.hs.down = true;
    await h.passes(30);
    h.hs.down = false;
    await h.passes(5);
    expect(rolls(h)).toBe(0);
    expect(
      meshLogs(h, "node_mesh_coordinator_health").some(
        (l) => l.fields.outcome === "failed"
      )
    ).toBe(true);
  });

  it("an offline substrate-gw resets the count", async () => {
    const h = harness();
    const a = await deployed(h, "poly");
    for (const d of h.hs.devicesOf(a.mesh?.headscaleKeyId))
      h.hs.devices.delete(d.headscaleDeviceId);
    const gw = [...h.hs.devices.values()].find((d) =>
      d.tags.includes("tag:substrate")
    ) as MeshDevice;
    await h.passes(8);
    h.hs.devices.set(gw.headscaleDeviceId, { ...gw, online: false });
    await h.passes(1);
    h.hs.devices.set(gw.headscaleDeviceId, gw);
    await h.passes(9);
    expect(rolls(h)).toBe(0);
    await h.passes(2);
    expect(rolls(h)).toBe(1);
  });

  it("a booting attempt is never rolled by the device check", async () => {
    const h = harness();
    await h.seq.reconcileAll();
    const { release } = await h.release("poly");
    const booting = await h.store.insertAttempt(release.id, () => "nd:x", {
      transport: "mesh",
    });
    await h.store.updateAttempt(booting.id, {
      phase: "proving",
      mesh: {
        ports: [5435],
        deviceName: "poly-app-x-a1",
        images: MESH_COMPANION_IMAGES,
        headscaleKeyId: "9999",
      },
    });
    await h.passes(30);
    expect(rolls(h)).toBe(0);
    expect((await h.attempts("poly"))[0]?.phase).toBe("proving");
  });

  it("at most 2 device-driven rolls are in flight per env", async () => {
    const h = harness();
    h.setAutoJoin(true);
    for (const slug of ["poly", "toks5", "red"] as const)
      await deployed(h, slug);
    for (const d of [...h.hs.devices.values()])
      if (d.headscaleKeyId) h.hs.devices.delete(d.headscaleDeviceId);
    await h.passes(12);
    expect(rolls(h)).toBe(2);
    expect(
      meshLogs(h, "node_mesh_device_roll_deferred").length
    ).toBeGreaterThan(0);
    const workloads = await Promise.all(
      (["poly", "toks5", "red"] as const).map((s) => h.attempts(s))
    );
    expect(deviceRollsInFlight(workloads, h.clock.now())).toBe(2);
  });

  it("more than one online device on one key for 2 minutes logs node_mesh_device_clone", async () => {
    const h = harness();
    await deployed(h, "poly");
    h.hs.join(meshOf(appCreates(h)[0])?.env?.TS_AUTHKEY ?? "", "clone");
    await h.passes(2);
    expect(meshLogs(h, "node_mesh_device_clone")).toHaveLength(0);
    await h.passes(2);
    expect(meshLogs(h, "node_mesh_device_clone")).toHaveLength(1);
    expect(rolls(h)).toBe(0);
  });
});

describe("HR 23: no gateway, no paid create", () => {
  it("a release with no substrate-gw waits unpaid and logs node_mesh_mint_refused; it deploys once the gateway is back", async () => {
    const h = harness();
    const [gw] = [...h.hs.devices.values()];
    if (!gw) throw new Error("no seeded gateway");
    h.hs.devices.clear();
    await h.seq.reconcileAll();
    await h.release("poly");
    await h.seq.step(h.key("poly"));
    const [waiting] = await h.attempts("poly");
    expect(waiting?.phase).toBe("planned");
    expect(waiting?.error).toBe("mesh_key_pending: mint_gateway_absent");
    expect(h.payer.createRequests).toHaveLength(0);
    expect(h.hs.calls).not.toContain("CreatePreAuthKey");
    const refused = meshLogs(h, "node_mesh_mint_refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]?.level).toBe("warn");
    expect(refused[0]?.fields).toMatchObject({
      nodeId: NODES.poly,
      env: ENV,
      releaseId: waiting?.releaseId,
      attempt: 1,
      outcome: "refused",
      reason: "gateway_absent",
    });

    // An offline gateway is no better: still unpaid.
    h.hs.devices.set(gw.headscaleDeviceId, { ...gw, online: false });
    await h.seq.step(h.key("poly"));
    expect((await h.attempts("poly"))[0]?.error).toBe(
      "mesh_key_pending: mint_gateway_offline"
    );
    expect(h.payer.createRequests).toHaveLength(0);

    // The gateway is online again: the SAME attempt mints, stores and pays once.
    h.hs.devices.set(gw.headscaleDeviceId, gw);
    await h.seq.step(h.key("poly"));
    const [a] = await h.attempts("poly");
    expect(a?.id).toBe(waiting?.id);
    expect(a?.phase).toBe("active");
    expect(appCreates(h)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// HR 10, HR 11: wipe recovery and gateway approval
// ---------------------------------------------------------------------------------------------

describe("HR 11: substrate-gw approval over the verified channel, no key compare", () => {
  const gateways = (h: H) =>
    [...h.hs.devices.values()].filter((d) => d.tags.includes("tag:substrate"));

  it("approves a fresh published auth id once; a publish that lags names it again and nothing is re-registered", async () => {
    const h = harness();
    h.hs.devices.clear(); // no gateway yet
    await h.seq.reconcileAll();
    h.hs.pending.set("auth-1", {
      machineKey: "mkey:gw",
      nodeKey: "nodekey:gw",
    });
    h.published.request = { authId: "auth-1", publishedAt: h.clock.now() };
    await h.passes(1);
    expect(gateways(h)).toHaveLength(1);
    expect(
      meshLogs(h, "node_mesh_substrate_approved")[0]?.fields
    ).toMatchObject({ outcome: "approved", expiryDisabled: true });
    await h.passes(2); // the publisher has not caught up yet
    expect(h.hs.calls.filter((c) => c === "AuthRegister")).toHaveLength(1);
    expect(meshLogs(h, "node_mesh_substrate_refused")).toHaveLength(0);
  });

  /** substrate-gw lost its tailscaled state: its old device stays (offline, no expiry); a release waits. */
  async function stateLoss(h: H) {
    const [old] = gateways(h);
    if (!old) throw new Error("no seeded gateway");
    h.hs.devices.set(old.headscaleDeviceId, { ...old, online: false });
    await h.seq.reconcileAll();
    await h.release("poly");
    await h.seq.step(h.key("poly"));
    expect((await h.attempts("poly"))[0]?.error).toBe(
      "mesh_key_pending: mint_gateway_offline"
    );
    h.hs.pending.set("auth-2", { machineKey: "mkey:new", nodeKey: "nk:new" });
    h.published.request = { authId: "auth-2", publishedAt: h.clock.now() };
    return old;
  }

  it("state loss: a new verified request supersedes the old offline gateway, and the waiting release deploys", async () => {
    const h = harness();
    const old = await stateLoss(h);
    await h.passes(1);
    const [now] = gateways(h);
    expect(gateways(h)).toHaveLength(1);
    expect(now?.headscaleDeviceId).not.toBe(old.headscaleDeviceId);
    const log = meshLogs(h, "node_mesh_substrate_superseded")[0];
    expect(log?.fields).toMatchObject({
      outcome: "deleted",
      headscaleDeviceId: now?.headscaleDeviceId,
      deletedDeviceIds: [old.headscaleDeviceId],
      pendingDeviceIds: [],
    });
    expect(meshLogs(h, "node_mesh_substrate_mismatch")).toHaveLength(0);
    expect(h.payer.createRequests).toHaveLength(0);
    await h.seq.step(h.key("poly"));
    expect((await h.attempts("poly"))[0]?.phase).toBe("active");
    expect(appCreates(h)).toHaveLength(1);
  });

  it("N1: a failed supersede delete is retried on the next pass; the release stays unpaid until it lands", async () => {
    const h = harness();
    const old = await stateLoss(h);
    h.hs.failDelete.add(old.headscaleDeviceId);
    await h.passes(1);
    expect(gateways(h)).toHaveLength(2); // the approved device is kept; the old one waits on the retry
    expect(
      meshLogs(h, "node_mesh_substrate_superseded")[0]?.fields
    ).toMatchObject({
      outcome: "delete_pending",
      pendingDeviceIds: [old.headscaleDeviceId],
    });
    await h.seq.step(h.key("poly"));
    expect((await h.attempts("poly"))[0]?.error).toBe(
      "mesh_key_pending: mint_gateway_multiple"
    );
    expect(h.payer.createRequests).toHaveLength(0);
    h.published.request = null; // registered: the publisher clears its auth id
    await h.passes(1);
    expect(
      meshLogs(h, "node_mesh_substrate_delete_retry")[0]?.fields
    ).toMatchObject({
      outcome: "ok",
      deletedDeviceIds: [old.headscaleDeviceId],
    });
    expect(gateways(h)).toHaveLength(1);
    await h.seq.step(h.key("poly"));
    expect((await h.attempts("poly"))[0]?.phase).toBe("active");
  });

  it("publisher stopped after approval: substrate-gw stays enrolled and nothing alerts", async () => {
    const h = harness();
    h.hs.devices.clear();
    await h.seq.reconcileAll();
    h.hs.pending.set("auth-1", {
      machineKey: "mkey:gw",
      nodeKey: "nodekey:gw",
    });
    h.published.request = { authId: "auth-1", publishedAt: h.clock.now() };
    await h.passes(1);
    h.published.request = null; // the publisher stops
    await h.passes(15);
    expect(meshLogs(h, "node_mesh_substrate_mismatch")).toHaveLength(0);
    expect(gateways(h)).toHaveLength(1);
  });

  it("a forged auth id approves nothing", async () => {
    const h = harness();
    h.hs.devices.clear();
    await h.seq.reconcileAll();
    h.published.request = { authId: "forged", publishedAt: h.clock.now() };
    await h.passes(1);
    expect(meshLogs(h, "node_mesh_substrate_refused")[0]?.fields.reason).toBe(
      "registration_not_found"
    );
    expect(gateways(h)).toHaveLength(0);
  });
});

describe("HR 10, 11: a wiped Headscale recovers by derivation, with no person", () => {
  it("re-seeds deny-all then the derived policy, re-approves the published substrate-gw, and re-keys the live lease", async () => {
    const h = harness();
    const a = await deployed(h, "poly");
    h.hs.wipe();
    h.hs.calls.length = 0;
    await h.passes(1);
    const sets = h.hs.calls.filter((c) => c.startsWith("SetPolicy"));
    expect(sets).toEqual(["SetPolicy:0", "SetPolicy:1"]);
    expect(
      meshLogs(h, "node_mesh_policy").some((l) => l.fields.wasAbsent === true)
    ).toBe(true);

    // The VM publishes its pending auth id; the pass approves it (HR 11).
    h.hs.pending.set("auth-1", {
      machineKey: "mkey:gw2",
      nodeKey: "nodekey:gw2",
    });
    h.published.request = {
      authId: "auth-1",
      publishedAt: h.clock.now() + 60_000,
    };
    await h.passes(1);
    expect(meshLogs(h, "node_mesh_substrate_approved")).toHaveLength(1);
    expect(meshLogs(h, "node_mesh_substrate_mismatch")).toHaveLength(0);
    // A stale publish is refused.
    h.published.request = {
      authId: "auth-2",
      publishedAt: h.clock.now() - 10 * 60_000,
    };
    await h.passes(1);
    expect(
      meshLogs(h, "node_mesh_substrate_refused").at(-1)?.fields.reason
    ).toBe("stale");
    h.published.request = null;

    // The live lease's key and device are gone with the volume: one roll after 10 minutes of a
    // healthy gateway, then a fresh key.
    await h.passes(DEVICE_ABSENT_ROLL_MS / 60_000 + 1);
    expect(rolls(h)).toBe(1);
    // The 5 s tick redeploys BEFORE the next mesh pass (reviewer's B1 scenario).
    await h.seq.step(h.key("poly"));
    const [next, old] = await h.attempts("poly");
    expect(next?.phase).toBe("active");
    expect(old?.id).toBe(a.id);
    // A wiped database restarts ids: the new key may carry the old id, but in a new epoch (HR 23).
    expect(next?.mesh?.headscaleKeyId).toBe(a.mesh?.headscaleKeyId);
    expect(next?.mesh?.headscaleEpoch).not.toBe(a.mesh?.headscaleEpoch);
    await h.passes(2);
    // The old attempt's id is void: it expired nothing and deleted nothing of the new attempt.
    expect(h.hs.expired(next?.mesh?.headscaleKeyId)).toBe(false);
    expect(h.hs.devicesOf(next?.mesh?.headscaleKeyId)).toHaveLength(1);
    const voided = (await h.attempts("poly")).find((x) => x.id === a.id);
    expect(voided?.mesh?.revokedAt).toBeDefined();
    expect(
      meshLogs(h, "node_mesh_key_void").some(
        (l) => l.fields.outcome === "older_epoch"
      )
    ).toBe(true);
    // The new attempt's device is counted for it, so it is never rolled for absence.
    await h.passes(15);
    expect(rolls(h)).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Review #3050: B4 one Headscale writer, B5 drain after a switch-back
// ---------------------------------------------------------------------------------------------

describe("bug.5585: a busy wallet keeps its wait start across mesh prep", () => {
  it("a mesh attempt waits on a busy wallet, alerts at walletWaitMs, then lands on the same attempt", async () => {
    const h = harness();
    await h.seq.reconcileAll();
    let walletBusy = true;
    h.payer.createFault = () =>
      walletBusy
        ? new PayerError("wallet_allocation_blocked", "busy", false)
        : undefined;
    await h.release("poly");
    const since = h.clock.now();
    for (let i = 0; i < 18; i++) {
      await h.seq.step(h.key("poly"));
      h.clock.advance(120_000);
    }
    const waiting = await h.attempts("poly");
    expect(
      waiting.map((a) => [a.attempt, a.phase, a.transport, a.error])
    ).toEqual([[1, "planned", "mesh", `unpaid: wallet_busy@${since}`]]);
    expect(
      h.log.alerts().filter((a) => a === "wallet_wait_exceeded")
    ).toHaveLength(1);
    walletBusy = false;
    await h.seq.step(h.key("poly"));
    expect((await h.attempts("poly")).map((a) => [a.attempt, a.phase])).toEqual(
      [[1, "active"]]
    );
  });
});

describe("review fixes", () => {
  it("B4: a concurrent mesh pass and mint serialize; the new key is granted and never swept", async () => {
    const h = harness();
    await h.seq.reconcileAll();
    await h.release("poly");
    await Promise.all([h.seq.reconcileAll(), h.seq.step(h.key("poly"))]);
    await h.passes(3);
    const [a] = await h.attempts("poly");
    expect(a?.phase).toBe("active");
    expect(h.hs.expired(a?.mesh?.headscaleKeyId)).toBe(false);
    expect(h.hs.policy).toContain(`tag:node-${NODES.poly}`);
    expect(meshLogs(h, "node_mesh_policy_drift")).toHaveLength(0);
  });

  it("B5: a lane switched back to egress still revokes and deletes leftover mesh keys, then goes quiet", async () => {
    const h = harness();
    const meshed = await deployed(h, "poly");
    h.restart("drain"); // NODE_DEPLOY_SUBSTRATE_TRANSPORTS no longer lists the lane as mesh
    h.payer.byDseq(meshed.externalName ?? "").state = "closed";
    await h.passes(1); // lost lease
    await h.seq.step(h.key("poly"));
    const [redeploy] = await h.attempts("poly");
    expect(redeploy?.transport).toBe("egress");
    await h.passes(2);
    const drained = (await h.attempts("poly")).find((a) => a.id === meshed.id);
    expect(drained?.mesh?.revokedAt).toBeDefined();
    expect(drained?.mesh?.secretDeletedAt).toBeDefined();
    expect(h.hs.expired(meshed.mesh?.headscaleKeyId)).toBe(true);
    expect(h.keys.secrets.size).toBe(0);
    // Nothing left to drain: no Headscale call at all.
    h.hs.calls.length = 0;
    await h.passes(2);
    expect(h.hs.calls).toEqual([]);
  });
});
