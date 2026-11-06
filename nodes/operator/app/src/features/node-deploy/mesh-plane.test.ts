// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/mesh-plane.test`
 * Purpose: Prove the seed-and-approval loop over a fake Headscale port that follows v0.29.7's observed
 *   rules (task.5429): fail closed before any mint or approval (HR 4), one usable key per attempt across
 *   a lost mint response and a restart (HR 5), expire-then-delete revocation (HR 6), verified substrate
 *   approval with delete-on-mismatch (HR 11), no mint without exactly one online `substrate-gw` in the
 *   current coordinator epoch (HR 23), zero API keys (HR 12), and no mesh identifier in governance,
 *   billing or RLS code (HR 13).
 * Scope: MeshPlane over a fake port. Does not reach a real Headscale (see the component contract test).
 * Invariants: every hard requirement named above has at least one falsifying case here.
 * Side-effects: IO (HR 13 reads repository source files)
 * Links: mesh-plane.ts, tests/component/node-deploy/headscale.adapter.int.test.ts
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  type CreatePreAuthKeyInput,
  type HeadscaleDeviceId,
  type HeadscaleKeyId,
  type HeadscaleUser,
  headscaleDeviceId,
  headscaleKeyId,
  type MeshApiKey,
  type MeshDevice,
  type MeshPolicy,
  type MeshPreAuthKey,
  type MeshUser,
  type MintedPreAuthKey,
  NodeMeshError,
  type NodeMeshPort,
} from "@/ports";

import {
  ATTEMPT_KEY_EXPIRATION,
  MESH_SECRET_NAME_PATTERN,
  MeshPlane,
  meshSecretName,
  SUBSTRATE_MISMATCH_ALERT,
  SUBSTRATE_REQUEST_MAX_AGE_MS,
} from "./mesh-plane";
import { denyAllPolicy, serializeMeshPolicy } from "./mesh-policy";

const NODE_A = "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d";
const NODE_B = "0b9d3c2e-1111-4222-8333-944455556666";
const RELEASE_1 = "11111111-2222-4333-8444-555555555555";
const RELEASE_2 = "66666666-7777-4888-9999-aaaaaaaaaaaa";
const T0 = Date.UTC(2026, 10, 6, 12, 0, 0);
const GRANTS = [
  { nodeId: NODE_A, ports: [5432, 6379] },
  { nodeId: NODE_B, ports: [5435] },
];

interface FakeKey {
  id: string;
  tags: string[];
  reusable: boolean;
  ephemeral: boolean;
  used: boolean;
  expiration: number;
  createdAt: number;
  key: string;
}

/**
 * A Headscale v0.29.7 stand-in. Rules taken from upstream source at the pinned commit: an absent policy
 * is `acl policy not found`; ExpirePreAuthKey stamps `now` and is a no-op for an unknown id; DeleteNode of
 * an unknown id is NotFound; a join with an expired key is `authkey expired`; a reusable key re-joins.
 */
class FakeHeadscale implements NodeMeshPort {
  now = T0;
  policy: string | null = null;
  readonly users: string[] = [];
  /** Owner creation instants: the coordinator epoch (HR 23). */
  readonly userCreatedAt = new Map<string, string>();
  readonly keys = new Map<string, FakeKey>();
  readonly devices = new Map<string, MeshDevice>();
  /** Pending `substrate-gw` registrations by auth id: the tags the requester advertised. */
  readonly pending = new Map<string, { tags: string[] }>();
  readonly apiKeys: MeshApiKey[] = [];
  readonly calls: string[] = [];
  private seq = 0;
  private gatewaySeq = 0;
  /** Test hooks. */
  down = false;
  /** One shot: the next ListNodes fails. */
  failNextListNodes = false;
  /** One shot per id: the next DeleteNode of that id fails (the device stays). */
  readonly failDelete = new Set<string>();
  loseNextMintResponse = false;
  failExpire = false;
  readbackOverride: string | null = null;
  /** When set, ListNodes waits for it (one shot) to let a test interleave calls. */
  holdListNodes: Promise<void> | null = null;

  private enter(method: string): void {
    this.calls.push(method);
    if (this.down) throw new NodeMeshError(method, "unavailable", "other");
  }

  private nextId(): string {
    this.seq += 1;
    return String(this.seq);
  }

  private keyView(k: FakeKey): MeshPreAuthKey {
    return {
      headscaleKeyId: headscaleKeyId(k.id),
      tags: [...k.tags],
      reusable: k.reusable,
      ephemeral: k.ephemeral,
      used: k.used,
      expiration: new Date(k.expiration).toISOString(),
      createdAt: new Date(k.createdAt).toISOString(),
    };
  }

  async health() {
    this.enter("Health");
    return { databaseConnectivity: true };
  }
  async getPolicy(): Promise<MeshPolicy | null> {
    this.enter("GetPolicy");
    const p = this.readbackOverride ?? this.policy;
    return p === null
      ? null
      : { policy: p, updatedAt: new Date(this.now).toISOString() };
  }
  async setPolicy(policy: string): Promise<MeshPolicy> {
    this.enter(`SetPolicy:${policy}`);
    this.policy = policy;
    return { policy, updatedAt: new Date(this.now).toISOString() };
  }
  async createUser(name: HeadscaleUser): Promise<MeshUser> {
    this.enter("CreateUser");
    this.users.push(name);
    const createdAt = new Date(this.now).toISOString();
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
    const k: FakeKey = {
      id: this.nextId(),
      tags: [...input.tags],
      reusable: input.reusable,
      ephemeral: input.ephemeral,
      used: false,
      expiration: input.expiration.getTime(),
      createdAt: this.now,
      key: `hskey-auth-${this.seq}-secret`,
    };
    this.keys.set(k.id, k);
    if (this.loseNextMintResponse) {
      this.loseNextMintResponse = false;
      throw new NodeMeshError("CreatePreAuthKey", "timeout", "other");
    }
    return { ...this.keyView(k), key: k.key };
  }
  async expirePreAuthKey(id: HeadscaleKeyId): Promise<void> {
    this.enter(`ExpirePreAuthKey:${id}`);
    if (this.failExpire)
      throw new NodeMeshError("ExpirePreAuthKey", "unavailable", "other");
    const k = this.keys.get(id);
    if (k) k.expiration = this.now;
  }
  async listPreAuthKeys(): Promise<readonly MeshPreAuthKey[]> {
    this.enter("ListPreAuthKeys");
    return [...this.keys.values()].map((k) => this.keyView(k));
  }
  async listNodes(): Promise<readonly MeshDevice[]> {
    this.enter("ListNodes");
    if (this.failNextListNodes) {
      this.failNextListNodes = false;
      throw new NodeMeshError("ListNodes", "unavailable", "other");
    }
    if (this.holdListNodes) {
      const hold = this.holdListNodes;
      this.holdListNodes = null;
      await hold;
    }
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
        "unknown",
        "registration_not_found"
      );
    this.pending.delete(input.authId);
    return this.addDevice({
      tags: p.tags,
      machineKey: `mkey:${input.authId}`,
      nodeKey: `nodekey:${input.authId}`,
      keyId: null,
    });
  }
  async listApiKeys(): Promise<readonly MeshApiKey[]> {
    this.enter("ListApiKeys");
    return [...this.apiKeys];
  }

  /** What a companion does: join with a key value. */
  join(keyValue: string): MeshDevice {
    const k = [...this.keys.values()].find((x) => x.key === keyValue);
    if (!k) throw new Error("invalid authkey");
    if (k.expiration <= this.now) throw new Error("authkey expired");
    if (k.used && !k.reusable) throw new Error("authkey already used");
    k.used = true;
    return this.addDevice({
      tags: k.tags,
      machineKey: `mkey:${this.seq}`,
      nodeKey: `nodekey:${this.seq}`,
      keyId: k.id,
    });
  }

  addDevice(d: {
    tags: string[];
    machineKey: string;
    nodeKey: string;
    keyId: string | null;
  }): MeshDevice {
    const id = this.nextId();
    const device: MeshDevice = {
      headscaleDeviceId: headscaleDeviceId(id),
      name: `dev-${id}`,
      givenName: `dev-${id}`,
      machineKey: d.machineKey,
      nodeKey: d.nodeKey,
      tags: [...d.tags],
      online: true,
      headscaleKeyId: d.keyId ? headscaleKeyId(d.keyId) : null,
      headscaleUser: null,
      createdAt: new Date(this.now).toISOString(),
      lastSeen: null,
      expiry: null,
    };
    this.devices.set(id, device);
    return device;
  }

  /**
   * An enrolled `substrate-gw` (tags exactly `[tag:substrate]`, no key expiry). Its ids are their own
   * namespace, so seeding one leaves the key and device ids the tests count on unchanged.
   */
  addGateway(over: Partial<MeshDevice> = {}): MeshDevice {
    this.gatewaySeq += 1;
    const id = headscaleDeviceId(`gw${this.gatewaySeq}`);
    const device: MeshDevice = {
      headscaleDeviceId: id,
      name: "substrate-gw",
      givenName: "substrate-gw",
      machineKey: `mkey:${id}`,
      nodeKey: `nodekey:${id}`,
      tags: ["tag:substrate"],
      online: true,
      headscaleKeyId: null,
      headscaleUser: null,
      createdAt: new Date(this.now).toISOString(),
      lastSeen: null,
      expiry: null,
      ...over,
    };
    this.devices.set(id, device);
    return device;
  }

  usableKeys(): FakeKey[] {
    return [...this.keys.values()].filter((k) => k.expiration > this.now);
  }

  mutations(): string[] {
    return this.calls.filter((c) => !/^(Get|List|Health)/.test(c));
  }
}

const attempt = (releaseId: string, n: number, nodeId = NODE_A) => ({
  nodeId,
  workload: "app",
  releaseId,
  attempt: n,
});

/** A plane whose mint is open: a matched policy, a sweep and (by default) one online `substrate-gw`. */
async function readyPlane(
  fake: FakeHeadscale,
  opts: { readonly gateway?: boolean } = {}
): Promise<MeshPlane> {
  if (opts.gateway ?? true) fake.addGateway();
  const plane = new MeshPlane(fake, "candidate-a");
  expect((await plane.reconcilePolicy(GRANTS)).ready).toBe(true);
  expect((await plane.sweep(new Set(), fake.now)).ok).toBe(true);
  return plane;
}

describe("HR 4 — one derived policy, fail closed before any mint or approval", () => {
  it("a fresh Headscale gets the owner, then deny-all, then the derived policy, then a matching readback", async () => {
    const fake = new FakeHeadscale();
    const plane = new MeshPlane(fake, "candidate-a");

    // Before any readback matched: nothing is minted or approved, and no call reaches Headscale.
    expect(
      await plane.mintAttemptKey(attempt(RELEASE_1, 1), new Set(), fake.now)
    ).toEqual({
      outcome: "refused",
      reason: "policy_not_ready",
    });
    expect(
      await plane.approveSubstrateGateway(
        { authId: "a", publishedAt: fake.now },
        fake.now
      )
    ).toEqual({ outcome: "refused", reason: "policy_not_ready" });
    expect(fake.calls).toEqual([]);

    const result = await plane.reconcilePolicy(GRANTS);
    expect(result).toEqual({
      outcome: "written",
      ready: true,
      drift: false,
      wasAbsent: true,
    });
    expect(fake.users).toEqual(["cogni-mesh-candidate-a"]);
    const writes = fake.calls.filter((c) => c.startsWith("SetPolicy:"));
    expect(writes).toHaveLength(2);
    expect(writes[0]).toBe(
      `SetPolicy:${serializeMeshPolicy(denyAllPolicy(plane.owner))}`
    );
    const seed = JSON.parse(writes[0]?.slice("SetPolicy:".length) ?? "");
    expect(seed).toEqual({
      acls: [],
      tagOwners: { "tag:substrate": ["cogni-mesh-candidate-a@"] },
    });
    // The last call is the readback.
    expect(fake.calls.at(-1)).toBe("GetPolicy");
  });

  it("a matching policy is left alone; a hand edit is drift and is replaced on the next pass", async () => {
    const fake = new FakeHeadscale();
    const plane = new MeshPlane(fake, "candidate-a");
    await plane.reconcilePolicy(GRANTS);
    fake.calls.length = 0;

    expect(await plane.reconcilePolicy(GRANTS)).toEqual({
      outcome: "matched",
      ready: true,
      drift: false,
      wasAbsent: false,
    });
    expect(fake.mutations()).toEqual([]);

    const derivedText = fake.policy;
    fake.policy = "{}"; // a hand edit to allow-all
    const healed = await plane.reconcilePolicy(GRANTS);
    expect(healed).toMatchObject({
      outcome: "written",
      ready: true,
      drift: true,
    });
    expect(fake.policy).toBe(derivedText);
  });

  it("a readback that differs leaves minting closed", async () => {
    const fake = new FakeHeadscale();
    const plane = new MeshPlane(fake, "candidate-a");
    fake.readbackOverride = '{"acls":[]}';
    expect(await plane.reconcilePolicy(GRANTS)).toMatchObject({
      outcome: "readback_mismatch",
      ready: false,
    });
    await plane.sweep(new Set(), fake.now);
    expect(
      await plane.mintAttemptKey(attempt(RELEASE_1, 1), new Set(), fake.now)
    ).toEqual({
      outcome: "refused",
      reason: "policy_not_ready",
    });
    expect(fake.calls).not.toContain("CreatePreAuthKey");
  });

  it("a failed Headscale call closes minting until a good reconcile and sweep", async () => {
    const fake = new FakeHeadscale();
    const plane = await readyPlane(fake);
    fake.down = true;
    expect(await plane.reconcilePolicy(GRANTS)).toMatchObject({
      outcome: "coordinator_failed",
      ready: false,
    });
    fake.down = false;
    expect(plane.mintAllowed).toBe(false);
    await plane.reconcilePolicy(GRANTS);
    expect(
      await plane.mintAttemptKey(attempt(RELEASE_1, 1), new Set(), fake.now)
    ).toEqual({
      outcome: "refused",
      reason: "sweep_pending",
    });
    await plane.sweep(new Set(), fake.now);
    expect(
      (await plane.mintAttemptKey(attempt(RELEASE_1, 1), new Set(), fake.now))
        .outcome
    ).toBe("minted");
  });

  it("refuses a key for a node the matched policy does not define", async () => {
    const fake = new FakeHeadscale();
    const plane = await readyPlane(fake);
    const other = "99999999-9999-4999-8999-999999999999";
    expect(
      await plane.mintAttemptKey(
        attempt(RELEASE_1, 1, other),
        new Set(),
        fake.now
      )
    ).toEqual({
      outcome: "refused",
      reason: "node_not_in_policy",
    });
  });
});

describe("HR 5 — a fresh key per release and attempt, and a lost mint response", () => {
  it("mints one reusable, ephemeral, node-tagged key with no practical time ceiling", async () => {
    const fake = new FakeHeadscale();
    const plane = await readyPlane(fake);
    const minted = await plane.mintAttemptKey(
      attempt(RELEASE_1, 1),
      new Set(),
      fake.now
    );
    expect(minted).toMatchObject({
      outcome: "minted",
      secretName: `nd-4ff8eac1-app-mesh-${RELEASE_1}-a1`,
      expiredOrphans: [],
    });
    const [key] = [...fake.keys.values()];
    expect(key).toMatchObject({
      tags: [`tag:node-${NODE_A}`],
      reusable: true,
      ephemeral: true,
      expiration: ATTEMPT_KEY_EXPIRATION.getTime(),
    });
  });

  it("drop the mint response, restart: one stored key, the unstored key expired, never a retry inside a call", async () => {
    const fake = new FakeHeadscale();
    const before = await readyPlane(fake);
    fake.loseNextMintResponse = true;
    const lost = await before.mintAttemptKey(
      attempt(RELEASE_1, 1),
      new Set(),
      fake.now
    );
    expect(lost).toEqual({ outcome: "failed", reason: "other" });
    expect(fake.calls.filter((c) => c === "CreatePreAuthKey")).toHaveLength(1);
    // Headscale made a key nobody stored. The same process refuses to mint until it sweeps.
    expect(
      await before.mintAttemptKey(attempt(RELEASE_1, 1), new Set(), fake.now)
    ).toEqual({
      outcome: "refused",
      reason: "policy_not_ready",
    });

    // Sequencer restart: a new process, nothing stored (no Secret exists for the attempt).
    fake.now += 5_000;
    // Same Headscale, so the same enrolled substrate-gw. Its sweep skips the orphan: newer than one pass.
    const after = await readyPlane(fake, { gateway: false });
    const stored = new Set<HeadscaleKeyId>();
    const minted = await after.mintAttemptKey(
      attempt(RELEASE_1, 1),
      stored,
      fake.now
    );
    if (minted.outcome !== "minted") throw new Error("mint");
    stored.add(minted.headscaleKeyId); // create-once Secret, before the paid create
    // The orphan is younger than one pass, so the mint leaves it (it could be a sibling's unstored key).
    expect(minted.expiredOrphans).toEqual([]);
    expect(fake.calls.filter((c) => c === "CreatePreAuthKey")).toHaveLength(2);

    // One pass later the sweep expires the unstored key; only the stored key stays usable.
    fake.now += 61_000;
    const swept = await after.sweep(stored, fake.now);
    expect(swept).toMatchObject({
      ok: true,
      expiredKeys: [headscaleKeyId("1")],
    });
    expect(fake.usableKeys().map((k) => k.id)).toEqual([minted.headscaleKeyId]);
    expect(() => fake.join("hskey-auth-1-secret")).toThrow("authkey expired");
    expect(fake.calls.filter((c) => c === "CreatePreAuthKey")).toHaveLength(2);
  });

  it("a mint expires an unstored same-tag key older than one pass BEFORE it creates the new key", async () => {
    const fake = new FakeHeadscale();
    const plane = await readyPlane(fake);
    fake.loseNextMintResponse = true;
    await plane.mintAttemptKey(attempt(RELEASE_1, 1), new Set(), fake.now);
    fake.now += 61_000;
    // Reconcile again, but sweep with the orphan treated as live (e.g. a stale caller set) so only
    // the mint's own orphan rule can expire it.
    await plane.reconcilePolicy(GRANTS);
    await plane.sweep(new Set([headscaleKeyId("1")]), fake.now);
    const minted = await plane.mintAttemptKey(
      attempt(RELEASE_1, 1),
      new Set(),
      fake.now
    );
    if (minted.outcome !== "minted") throw new Error("mint");
    expect(minted.expiredOrphans).toEqual([headscaleKeyId("1")]);
    const expireAt = fake.calls.indexOf("ExpirePreAuthKey:1");
    expect(expireAt).toBeGreaterThan(-1);
    expect(expireAt).toBeLessThan(fake.calls.lastIndexOf("CreatePreAuthKey"));
    expect(fake.usableKeys().map((k) => k.id)).toEqual([minted.headscaleKeyId]);
  });

  it("concurrent mints for two workloads of one node never expire each other's unstored keys (CD8)", async () => {
    const fake = new FakeHeadscale();
    const plane = await readyPlane(fake);
    const stored = new Set<HeadscaleKeyId>(); // neither Secret is written yet
    const app = { ...attempt(RELEASE_1, 1), workload: "app" };
    const worker = { ...attempt(RELEASE_2, 1), workload: "worker" };
    fake.calls.length = 0;
    const [a, b] = await Promise.all([
      plane.mintAttemptKey(app, stored, fake.now),
      plane.mintAttemptKey(worker, stored, fake.now),
    ]);
    if (a.outcome !== "minted" || b.outcome !== "minted")
      throw new Error("mint");
    expect(a.expiredOrphans).toEqual([]);
    expect(b.expiredOrphans).toEqual([]);
    expect(fake.calls.some((c) => c.startsWith("ExpirePreAuthKey:"))).toBe(
      false
    );
    expect(
      fake
        .usableKeys()
        .map((k) => k.id)
        .sort()
    ).toEqual([a.headscaleKeyId, b.headscaleKeyId].sort());
    // Sequential too: the second mint, one second later, still leaves the first's unstored key.
    fake.now += 1_000;
    const c = await plane.mintAttemptKey(app, stored, fake.now);
    if (c.outcome !== "minted") throw new Error("mint");
    expect(c.expiredOrphans).toEqual([]);
    expect(fake.usableKeys()).toHaveLength(3);
  });

  it("a sweep in flight when another call fails does not reopen minting (failure counter)", async () => {
    const fake = new FakeHeadscale();
    const plane = await readyPlane(fake);
    let release = () => {};
    fake.holdListNodes = new Promise<void>((r) => {
      release = r;
    });
    fake.calls.length = 0;
    const sweeping = plane.sweep(new Set(), fake.now);
    for (let i = 0; i < 50 && !fake.calls.includes("ListNodes"); i++)
      await Promise.resolve();
    expect(fake.calls).toContain("ListNodes"); // the sweep is parked inside ListNodes
    // While the sweep waits on ListNodes, a reconcile fails.
    fake.down = true;
    expect((await plane.reconcilePolicy(GRANTS)).outcome).toBe(
      "coordinator_failed"
    );
    fake.down = false;
    // A reconcile that succeeds now does not stand in for the sweep.
    expect((await plane.reconcilePolicy(GRANTS)).ready).toBe(true);
    release();
    const swept = await sweeping;
    expect(swept.ok).toBe(false);
    expect(plane.mintAllowed).toBe(false);
    expect(
      await plane.mintAttemptKey(attempt(RELEASE_1, 1), new Set(), fake.now)
    ).toEqual({ outcome: "refused", reason: "sweep_pending" });
    // A sweep that starts after the failure reopens it.
    expect((await plane.sweep(new Set(), fake.now)).ok).toBe(true);
    expect(plane.mintAllowed).toBe(true);
  });

  it("the sweep alone expires an unstored key once it is older than one pass", async () => {
    const fake = new FakeHeadscale();
    const plane = await readyPlane(fake);
    fake.loseNextMintResponse = true;
    await plane.mintAttemptKey(attempt(RELEASE_1, 1), new Set(), fake.now);
    fake.now += 61_000;
    const swept = await plane.sweep(new Set(), fake.now);
    expect(swept).toMatchObject({ ok: true, expiredKeys: ["1"] });
    expect(fake.usableKeys()).toEqual([]);
  });

  it("release 2 attempt 1 gets a new Secret name and a new key id, not release 1's", async () => {
    const fake = new FakeHeadscale();
    const plane = await readyPlane(fake);
    const live = new Set<HeadscaleKeyId>();
    const r1 = await plane.mintAttemptKey(
      attempt(RELEASE_1, 1),
      live,
      fake.now
    );
    if (r1.outcome !== "minted") throw new Error("mint 1");
    live.add(r1.headscaleKeyId);
    const r2 = await plane.mintAttemptKey(
      attempt(RELEASE_2, 1),
      live,
      fake.now
    );
    if (r2.outcome !== "minted") throw new Error("mint 2");
    expect(r2.secretName).not.toBe(r1.secretName);
    expect(r2.headscaleKeyId).not.toBe(r1.headscaleKeyId);
    expect(r2.expiredOrphans).toEqual([]); // release 1's stored key is live, never an orphan
  });

  it("attempt Secret names match the admission delete pattern; state passwords never do", () => {
    const name = meshSecretName(attempt(RELEASE_1, 3));
    expect(name).toMatch(MESH_SECRET_NAME_PATTERN);
    for (const statePassword of [
      "nd-4ff8eac1-db",
      "nd-4ff8eac1-x-mesh-y",
      "nd-4ff8eac1-app-mesh-notauuid-a1",
    ])
      expect(statePassword).not.toMatch(MESH_SECRET_NAME_PATTERN);
  });
});

describe("HR 6 — revocation expires the key first, then deletes its devices", () => {
  it("expire, then delete every device of the key, then read back; a re-join gets authkey expired", async () => {
    const fake = new FakeHeadscale();
    const plane = await readyPlane(fake);
    const live = new Set<HeadscaleKeyId>();
    const a = await plane.mintAttemptKey(attempt(RELEASE_1, 1), live, fake.now);
    if (a.outcome !== "minted") throw new Error("mint");
    live.add(a.headscaleKeyId);
    const b = await plane.mintAttemptKey(
      attempt(RELEASE_1, 1, NODE_B),
      live,
      fake.now
    );
    if (b.outcome !== "minted") throw new Error("mint b");
    const d1 = fake.join(a.key);
    const d2 = fake.join(a.key); // a companion restart: a second ephemeral device, same key
    const other = fake.join(b.key);
    const gw = headscaleDeviceId("gw1"); // the seeded substrate-gw
    fake.calls.length = 0;

    const revoked = await plane.revokeAttempt(a.headscaleKeyId, fake.now);
    expect(revoked).toEqual({
      outcome: "revoked",
      deletedDevices: [d1.headscaleDeviceId, d2.headscaleDeviceId],
    });
    const firstExpire = fake.calls.indexOf(
      `ExpirePreAuthKey:${a.headscaleKeyId}`
    );
    const firstDelete = fake.calls.findIndex((c) =>
      c.startsWith("DeleteNode:")
    );
    expect(firstExpire).toBeGreaterThan(-1);
    expect(firstExpire).toBeLessThan(firstDelete);
    expect(() => fake.join(a.key)).toThrow("authkey expired");
    expect([...fake.devices.keys()].sort()).toEqual(
      [other.headscaleDeviceId, gw].sort()
    );
  });

  it("a failed expire deletes nothing", async () => {
    const fake = new FakeHeadscale();
    const plane = await readyPlane(fake);
    const a = await plane.mintAttemptKey(
      attempt(RELEASE_1, 1),
      new Set(),
      fake.now
    );
    if (a.outcome !== "minted") throw new Error("mint");
    fake.join(a.key);
    fake.failExpire = true;
    fake.calls.length = 0;
    expect(await plane.revokeAttempt(a.headscaleKeyId, fake.now)).toEqual({
      outcome: "failed",
      stage: "expire",
      reason: "other",
    });
    expect(fake.calls.some((c) => c.startsWith("DeleteNode:"))).toBe(false);
    expect(fake.devices.size).toBe(2); // the companion and the seeded substrate-gw
  });

  it("never revokes a key outside tag:node-*", async () => {
    const fake = new FakeHeadscale();
    const plane = await readyPlane(fake);
    const substrateKey = await fake.createPreAuthKey({
      tags: ["tag:substrate"],
      reusable: false,
      ephemeral: false,
      expiration: ATTEMPT_KEY_EXPIRATION,
    });
    fake.calls.length = 0;
    expect(
      await plane.revokeAttempt(substrateKey.headscaleKeyId, fake.now)
    ).toEqual({
      outcome: "refused",
      reason: "not_a_node_key",
    });
    expect(fake.mutations()).toEqual([]);
  });

  it("the sweep is scoped to tag:node-*: it expires orphan node keys and their devices, and nothing else", async () => {
    const fake = new FakeHeadscale();
    const plane = await readyPlane(fake);
    const live = new Set<HeadscaleKeyId>();
    const kept = await plane.mintAttemptKey(
      attempt(RELEASE_1, 1),
      live,
      fake.now
    );
    if (kept.outcome !== "minted") throw new Error("mint");
    live.add(kept.headscaleKeyId);
    const keptDevice = fake.join(kept.key);
    const orphan = await fake.createPreAuthKey({
      tags: [`tag:node-${NODE_B}`],
      reusable: true,
      ephemeral: true,
      expiration: ATTEMPT_KEY_EXPIRATION,
    });
    const orphanDevice = fake.join(orphan.key);
    const foreign = await fake.createPreAuthKey({
      tags: ["tag:other"],
      reusable: true,
      ephemeral: false,
      expiration: ATTEMPT_KEY_EXPIRATION,
    });
    const foreignDevice = fake.join(foreign.key);
    const gw = headscaleDeviceId("gw1"); // the seeded substrate-gw
    // A node-tagged device with no key is anomalous: skipped and counted, never deleted.
    const unkeyed = fake.addDevice({
      tags: [`tag:node-${NODE_B}`],
      machineKey: "m2",
      nodeKey: "n2",
      keyId: null,
    });
    fake.now += 120_000;

    const swept = await plane.sweep(live, fake.now);
    expect(swept).toEqual({
      ok: true,
      expiredKeys: [orphan.headscaleKeyId],
      deletedDevices: [orphanDevice.headscaleDeviceId],
      unkeyedNodeDevices: [unkeyed.headscaleDeviceId],
    });
    expect([...fake.devices.keys()].sort()).toEqual(
      [
        keptDevice.headscaleDeviceId,
        foreignDevice.headscaleDeviceId,
        gw,
        unkeyed.headscaleDeviceId,
      ].sort()
    );
    expect(
      fake
        .usableKeys()
        .map((k) => k.id)
        .sort()
    ).toEqual([kept.headscaleKeyId, foreign.headscaleKeyId].sort());
    // Expire before delete, as in revoke.
    expect(
      fake.calls.indexOf(`ExpirePreAuthKey:${orphan.headscaleKeyId}`)
    ).toBeLessThan(
      fake.calls.indexOf(`DeleteNode:${orphanDevice.headscaleDeviceId}`)
    );
  });
});

describe("HR 11 — substrate-gw approval over the verified channel", () => {
  /** The VM publishes `{authId, publishedAt}`; the requester advertised `tags`. */
  const publish = (fake: FakeHeadscale, tags = ["tag:substrate"]) => {
    fake.pending.set("auth-1", { tags });
    return { authId: "auth-1", publishedAt: fake.now };
  };
  const unseeded = (fake: FakeHeadscale) =>
    readyPlane(fake, { gateway: false });

  it("approves a fresh published auth id whose device is exactly [tag:substrate] and the tailnet's only one", async () => {
    const fake = new FakeHeadscale();
    const plane = await unseeded(fake);
    const result = await plane.approveSubstrateGateway(
      publish(fake),
      fake.now + 30_000
    );
    expect(result).toMatchObject({ outcome: "approved", expiryDisabled: true });
    expect(fake.devices.size).toBe(1);
    // No key compare and no second stage: one AuthRegister, one device read, done.
    expect(fake.calls.filter((c) => c === "AuthRegister")).toHaveLength(1);
    expect(plane.approvedAuthId("auth-1")).toBe(true);
    expect(plane.approvedAuthId("auth-2")).toBe(false);
  });

  it("ignores a request published more than 5 minutes ago or in the future, without calling AuthRegister", async () => {
    const fake = new FakeHeadscale();
    const plane = await unseeded(fake);
    const req = publish(fake);
    expect(
      await plane.approveSubstrateGateway(
        req,
        req.publishedAt + SUBSTRATE_REQUEST_MAX_AGE_MS + 1
      )
    ).toEqual({ outcome: "refused", reason: "stale" });
    expect(
      await plane.approveSubstrateGateway(req, req.publishedAt - 120_000)
    ).toEqual({
      outcome: "refused",
      reason: "future",
    });
    expect(fake.calls).not.toContain("AuthRegister");
  });

  it("deletes at once and alerts when the registered tags are not exactly [tag:substrate]", async () => {
    const fake = new FakeHeadscale();
    const plane = await unseeded(fake);
    const result = await plane.approveSubstrateGateway(
      publish(fake, ["tag:substrate", `tag:node-${NODE_A}`]),
      fake.now
    );
    expect(result).toMatchObject({
      outcome: "mismatch",
      alert: SUBSTRATE_MISMATCH_ALERT,
      reason: "tags",
      deleted: true,
    });
    expect(fake.devices.size).toBe(0);
  });

  it("a verified approval supersedes an enrolled gateway: the older device goes, the approved one stays", async () => {
    const fake = new FakeHeadscale();
    const plane = await readyPlane(fake); // gw1 is enrolled and online, created at the same instant
    const result = await plane.approveSubstrateGateway(publish(fake), fake.now);
    if (result.outcome !== "approved") throw new Error(result.outcome);
    expect(result.supersede).toMatchObject({
      ok: true,
      kept: result.headscaleDeviceId,
      superseded: ["gw1"],
      failed: [],
    });
    expect([...fake.devices.keys()]).toEqual([result.headscaleDeviceId]);
  });

  it("state loss: an old offline gateway and a new verified request -> new approved, old deleted, mint allowed", async () => {
    const fake = new FakeHeadscale();
    fake.addGateway({ online: false }); // the VM lost its tailscaled state; gw1 never expires
    const plane = await readyPlane(fake, { gateway: false });
    const mint = () =>
      plane.mintAttemptKey(attempt(RELEASE_1, 1), new Set(), fake.now);
    expect(await mint()).toEqual({
      outcome: "refused",
      reason: "gateway_offline",
    });
    fake.now += 30_000;
    const result = await plane.approveSubstrateGateway(publish(fake), fake.now);
    if (result.outcome !== "approved") throw new Error(result.outcome);
    expect(result.supersede.superseded).toEqual(["gw1"]);
    expect([...fake.devices.keys()]).toEqual([result.headscaleDeviceId]);
    expect((await mint()).outcome).toBe("minted"); // the new device is online
  });

  it("a failed supersede delete keeps the approved device; the next pass recomputes and deletes the older one", async () => {
    const fake = new FakeHeadscale();
    fake.addGateway({ online: false });
    const plane = await readyPlane(fake, { gateway: false });
    fake.now += 30_000;
    fake.failDelete.add("gw1");
    const result = await plane.approveSubstrateGateway(publish(fake), fake.now);
    if (result.outcome !== "approved") throw new Error(result.outcome);
    expect(result.supersede).toMatchObject({
      ok: false,
      kept: result.headscaleDeviceId,
      superseded: [],
      failed: ["gw1"],
      reason: "other",
    });
    expect([...fake.devices.keys()].sort()).toEqual(
      ["gw1", result.headscaleDeviceId].sort()
    );
    // Next pass, no stored intent: the rule is recomputed from the device list.
    expect(await plane.supersedeGateways()).toMatchObject({
      ok: true,
      kept: result.headscaleDeviceId,
      superseded: ["gw1"],
    });
    expect([...fake.devices.keys()]).toEqual([result.headscaleDeviceId]);
  });

  it("restart: a fresh plane with two tag:substrate devices deletes the older on its first pass; mint opens once the newest is online", async () => {
    const fake = new FakeHeadscale();
    const old = fake.addGateway(); // gw1
    fake.now += 30_000;
    const newest = fake.addGateway({ online: false }); // gw2 is still joining
    const plane = new MeshPlane(fake, "candidate-a"); // a restarted sequencer: no memory
    expect((await plane.reconcilePolicy(GRANTS)).ready).toBe(true);
    expect(await plane.supersedeGateways()).toEqual({
      ok: true,
      kept: newest.headscaleDeviceId,
      superseded: [old.headscaleDeviceId],
      mismatched: [],
      failed: [],
    });
    expect((await plane.sweep(new Set(), fake.now)).ok).toBe(true);
    const mint = () =>
      plane.mintAttemptKey(attempt(RELEASE_1, 1), new Set(), fake.now);
    expect(await mint()).toEqual({
      outcome: "refused",
      reason: "gateway_offline",
    });
    fake.devices.set(newest.headscaleDeviceId, { ...newest, online: true });
    expect((await mint()).outcome).toBe("minted");
  });

  it("the pass deletes a tag:substrate device with another tag as a mismatch, and keeps the exact gateway", async () => {
    const fake = new FakeHeadscale();
    const plane = await readyPlane(fake); // gw1
    fake.now += 30_000;
    const wrong = fake.addGateway({ tags: ["tag:substrate", "tag:other"] });
    expect(await plane.supersedeGateways()).toEqual({
      ok: true,
      kept: "gw1",
      superseded: [],
      mismatched: [wrong.headscaleDeviceId],
      failed: [],
    });
    expect([...fake.devices.keys()]).toEqual(["gw1"]);
  });

  it("an auth id with no pending request approves nothing (a forged id)", async () => {
    const fake = new FakeHeadscale();
    const plane = await unseeded(fake);
    expect(
      await plane.approveSubstrateGateway(
        { authId: "nope", publishedAt: fake.now },
        fake.now
      )
    ).toEqual({ outcome: "refused", reason: "registration_not_found" });
    expect(fake.devices.size).toBe(0);
  });

  it("refuses a request with no auth id or no publish time without calling AuthRegister", async () => {
    const fake = new FakeHeadscale();
    const plane = await unseeded(fake);
    const req = publish(fake);
    for (const bad of [
      { ...req, authId: "" },
      { ...req, publishedAt: Number.NaN },
    ])
      expect(await plane.approveSubstrateGateway(bad, fake.now)).toEqual({
        outcome: "refused",
        reason: "malformed",
      });
    expect(fake.calls).not.toContain("AuthRegister");
  });

  describe("HR 23: a stored key id is void outside its coordinator epoch", () => {
    it("revoke by an id from an older epoch, or with another key creation time, makes no Headscale call", async () => {
      const fake = new FakeHeadscale();
      const plane = await readyPlane(fake);
      const epoch = plane.epoch ?? "";
      expect(epoch).not.toBe("");
      const key = await fake.createPreAuthKey({
        tags: [`tag:node-${NODE_A}`],
        reusable: true,
        ephemeral: true,
        expiration: ATTEMPT_KEY_EXPIRATION,
      });
      fake.calls.length = 0;
      expect(
        await plane.revokeAttempt(key.headscaleKeyId, fake.now, {
          epoch: "1999-01-01T00:00:00.000Z",
          keyCreatedAt: key.createdAt,
        })
      ).toEqual({ outcome: "void" });
      expect(fake.calls).toEqual([]);
      expect(
        await plane.revokeAttempt(key.headscaleKeyId, fake.now, {
          epoch,
          keyCreatedAt: "1999-01-01T00:00:00.000Z",
        })
      ).toEqual({ outcome: "void" });
      expect(fake.mutations()).toEqual([]);
      expect(
        await plane.revokeAttempt(key.headscaleKeyId, fake.now, {
          epoch,
          keyCreatedAt: key.createdAt,
        })
      ).toMatchObject({ outcome: "revoked" });
    });
  });
});

describe("HR 23 — no attempt key without exactly one online substrate-gw in the current epoch", () => {
  const mint = (plane: MeshPlane, fake: FakeHeadscale) =>
    plane.mintAttemptKey(attempt(RELEASE_1, 1), new Set(), fake.now);
  const refusedWith = async (
    fake: FakeHeadscale,
    plane: MeshPlane,
    reason: string
  ) => {
    fake.calls.length = 0;
    expect(await mint(plane, fake)).toEqual({ outcome: "refused", reason });
    // Refused before any write: nothing is expired and nothing is minted.
    expect(fake.mutations()).toEqual([]);
    expect(fake.keys.size).toBe(0);
  };

  it("no substrate-gw: refused, nothing minted", async () => {
    const fake = new FakeHeadscale();
    const plane = await readyPlane(fake, { gateway: false });
    await refusedWith(fake, plane, "gateway_absent");
  });

  it("an offline substrate-gw: refused, nothing minted", async () => {
    const fake = new FakeHeadscale();
    fake.addGateway({ online: false });
    const plane = await readyPlane(fake, { gateway: false });
    await refusedWith(fake, plane, "gateway_offline");
  });

  it("two tag:substrate devices, even both online: refused, nothing minted", async () => {
    const fake = new FakeHeadscale();
    fake.addGateway();
    const plane = await readyPlane(fake);
    await refusedWith(fake, plane, "gateway_multiple");
  });

  it("a substrate device with another tag: refused, nothing minted", async () => {
    const fake = new FakeHeadscale();
    fake.addGateway({ tags: ["tag:substrate", "tag:other"] });
    const plane = await readyPlane(fake, { gateway: false });
    await refusedWith(fake, plane, "gateway_tags");
  });

  it("the coordinator epoch changed since the reconcile (a wipe): refused, nothing minted", async () => {
    const fake = new FakeHeadscale();
    const plane = await readyPlane(fake);
    // A wipe re-creates the owner with a new creation time; the plane has not reconciled since.
    fake.now += 60_000;
    fake.userCreatedAt.set(
      "cogni-mesh-candidate-a",
      new Date(fake.now).toISOString()
    );
    await refusedWith(fake, plane, "epoch_changed");
  });

  it("a failed device read is a failed mint and closes minting", async () => {
    const fake = new FakeHeadscale();
    const plane = await readyPlane(fake);
    fake.failNextListNodes = true;
    expect(await mint(plane, fake)).toEqual({
      outcome: "failed",
      reason: "other",
    });
    expect(fake.calls).not.toContain("CreatePreAuthKey");
    expect(plane.mintAllowed).toBe(false);
  });

  it("exactly one online, exact-tag substrate-gw: the key is minted", async () => {
    const fake = new FakeHeadscale();
    const plane = await readyPlane(fake);
    expect((await mint(plane, fake)).outcome).toBe("minted");
  });
});

describe("HR 12 — no Headscale admin surface", () => {
  it("passes with zero API keys and fails with any", async () => {
    const fake = new FakeHeadscale();
    const plane = new MeshPlane(fake, "candidate-a");
    expect(await plane.checkAdminSurface()).toEqual({ ok: true });
    fake.apiKeys.push({
      headscaleApiKeyId: "1",
      createdAt: null,
      expiration: null,
    });
    expect(await plane.checkAdminSurface()).toEqual({ ok: false, apiKeys: 1 });
  });

  it("the port offers no call that creates an API key (exhaustive over NodeMeshPort)", () => {
    // `satisfies` fails to compile if a port method is added or removed without updating this list.
    const methods = {
      health: true,
      getPolicy: true,
      setPolicy: true,
      createUser: true,
      listUsers: true,
      createPreAuthKey: true,
      expirePreAuthKey: true,
      listPreAuthKeys: true,
      listNodes: true,
      deleteNode: true,
      authRegister: true,
      listApiKeys: true,
    } as const satisfies Record<keyof NodeMeshPort, true>;
    const names = Object.keys(methods);
    expect(names.filter((m) => /api.?key/i.test(m))).toEqual(["listApiKeys"]);
    expect(
      names.some(
        (m) =>
          /^(create|set|add|new|register|issue)/i.test(m) &&
          /key/i.test(m) &&
          m !== "createPreAuthKey"
      )
    ).toBe(false);
    // The fake implements exactly the port too.
    const fakeMethods = Object.getOwnPropertyNames(
      FakeHeadscale.prototype
    ).filter((m) => Object.hasOwn(methods, m));
    expect(fakeMethods.sort()).toEqual(names.sort());
  });
});

describe("HR 13 — the mesh is network only", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repo = path.resolve(here, "../../../../../..");
  /** Governance, billing, payment, identity and RLS code and schemas. */
  const ROOTS = [
    "nodes/operator/app/src/features/governance",
    "nodes/operator/app/src/features/accounts",
    "nodes/operator/app/src/features/payments",
    "nodes/operator/app/src/features/finance",
    "nodes/operator/app/src/features/treasury",
    "nodes/operator/app/src/features/identity",
    "nodes/operator/app/src/features/attribution",
    "nodes/operator/app/src/adapters/server/governance",
    "nodes/operator/app/src/adapters/server/accounts",
    "nodes/operator/app/src/adapters/server/payments",
    "nodes/operator/app/src/adapters/server/finance",
    "nodes/operator/app/src/adapters/server/treasury",
    "nodes/operator/app/src/adapters/server/identity",
    "nodes/operator/app/src/adapters/server/db",
    "packages/db-schema",
    "packages/db-client",
    "packages/financial-ledger",
    "packages/attribution-ledger",
    "packages/authorization-core",
    "packages/ids",
    "infra/openfga",
  ];
  const MESH_ID =
    /headscale|tag:node-|tag:substrate|cogni-mesh-|meshdevice|mesh_key|mesh_device/i;

  const walk = (dir: string, out: string[]): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry.startsWith("."))
        continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx|sql|json|yaml|yml|mjs|fga)$/.test(entry))
        out.push(full);
    }
  };

  it("no governance, billing or RLS path names a mesh identifier", () => {
    const files: string[] = [];
    for (const root of ROOTS) walk(path.join(repo, root), files);
    expect(files.length).toBeGreaterThan(100);
    const hits = files.filter((f) => MESH_ID.test(readFileSync(f, "utf8")));
    expect(hits.map((f) => path.relative(repo, f))).toEqual([]);
  });

  it("the search is not vacuous: it finds the mesh module itself", () => {
    expect(
      MESH_ID.test(readFileSync(path.join(here, "mesh-plane.ts"), "utf8"))
    ).toBe(true);
  });
});
