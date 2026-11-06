// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/mesh-plane`
 * Purpose: The seed-and-approval loop for ONE env's Headscale (task.5429, connectivity decision
 *   task.5384): reconcile the derived policy, approve the env VM's `substrate-gw` over its published
 *   request, mint one key per attempt, revoke an attempt, and sweep keys no live attempt stores.
 * Scope: Logic over `NodeMeshPort` only. Does not wire, touch Kubernetes or log: every outcome is returned
 *   so the sequencer (slice T4) records it through its one emit helper.
 * Invariants:
 *   - FAIL_CLOSED_BEFORE_MINT (HR 4): no key is minted and no device is approved until a policy readback
 *     in this process matched the derivation. An absent or different policy is first replaced by the
 *     deny-all seed, then by the derived policy, then read back.
 *   - SWEEP_BEFORE_MINT (HR 5): after a process start or any failed Headscale call, a mint is refused until
 *     a sweep has succeeded, so a key whose mint response was lost is expired before a new one exists.
 *   - ONE_TRY_PER_MINT (HR 5): a mint that fails or loses its response is never retried inside the call.
 *     The unstored key, if Headscale made one, is expired by the sweep or, at the latest, by the next
 *     mint for that node before it creates a key: at most one usable unstored key exists.
 *   - EXPIRE_THEN_DELETE (HR 6): revoke and sweep expire the key first and delete its devices only after
 *     the expire succeeded; a reusable key that still works would re-join a deleted device.
 *   - NODE_SCOPE_ONLY: revoke and sweep act only on keys and devices whose tags are all `tag:node-*`.
 *     They never touch `tag:substrate` or any other tag.
 *   - VERIFIED_APPROVAL (HR 11): a published request older than 5 minutes is refused. After
 *     `AuthRegister` the device must have tags exactly `[tag:substrate]` and the published machine and
 *     node keys, else it is deleted at once and the result carries `node_mesh_substrate_mismatch`.
 *   - ZERO_API_KEYS (HR 12): `checkAdminSurface` passes only when Headscale lists no API key.
 *   - NETWORK_ONLY (HR 13): every id here is a namespaced provider id; none is a Cogni identity key.
 * Side-effects: IO
 * Links: mesh-policy.ts, ports/node-mesh.port.ts
 * @public
 */

import {
  type HeadscaleDeviceId,
  type HeadscaleKeyId,
  type HeadscaleUser,
  isNodeMeshError,
  type MeshDevice,
  type NodeMeshErrorReason,
  type NodeMeshPort,
} from "@/ports";

import {
  denyAllPolicy,
  deriveMeshPolicy,
  isNodeTag,
  type MeshPolicyDocument,
  meshOwner,
  type NodeSubstrateGrant,
  nodeTag,
  policyMatches,
  policyNodeTags,
  SUBSTRATE_TAG,
  serializeMeshPolicy,
} from "./mesh-policy";

/** A published `substrate-gw` request older than this is ignored (design section 2). */
export const SUBSTRATE_REQUEST_MAX_AGE_MS = 5 * 60_000;
/** A request "published" further in the future than this is refused too (clock skew bound). */
export const SUBSTRATE_REQUEST_MAX_SKEW_MS = 60_000;
/** The sweep skips keys newer than one sequencer pass (design section 3). */
export const DEFAULT_SWEEP_MIN_AGE_MS = 60_000;
/**
 * "No time ceiling" (design section 3). Headscale v0.29.7 stores an absent expiration as the zero time,
 * which is already expired, so the attempt key carries a far-future date and the attempt close expires it.
 */
export const ATTEMPT_KEY_EXPIRATION = new Date(Date.UTC(2100, 0, 1));
export const SUBSTRATE_MISMATCH_ALERT = "node_mesh_substrate_mismatch";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** The admission policy's delete allow-list for attempt mesh Secrets (design section 3). */
export const MESH_SECRET_NAME_PATTERN = new RegExp(
  `^nd-[0-9a-f]{8}-[a-z0-9-]+-mesh-${UUID}-a[0-9]+$`
);

/** `nd-<nodeId8>-<workload>-mesh-<releaseId>-a<attempt>`: the create-once Secret for one attempt key. */
export const meshSecretName = (input: {
  readonly nodeId: string;
  readonly workload: string;
  readonly releaseId: string;
  readonly attempt: number;
}): string => {
  const name =
    `nd-${input.nodeId.replace(/-/g, "").slice(0, 8)}-${input.workload}-mesh-${input.releaseId}-a${input.attempt}`.toLowerCase();
  if (!MESH_SECRET_NAME_PATTERN.test(name))
    throw new Error(`attempt mesh secret name is not admissible: ${name}`);
  return name;
};

export type ReconcileOutcome =
  /** The stored policy already matched. */
  | "matched"
  /** We wrote deny-all then the derivation, and the readback matched. */
  | "written"
  /** We wrote, but the readback differs: not ready. */
  | "readback_mismatch"
  /** A Headscale call failed: not ready. */
  | "coordinator_failed";

export interface ReconcileResult {
  readonly outcome: ReconcileOutcome;
  /** True only when a readback in this call matched the derivation. */
  readonly ready: boolean;
  /** True when a policy existed and differed from the derivation (log `node_mesh_policy_drift`). */
  readonly drift: boolean;
  /** True when Headscale had no stored policy at all (fresh or wiped). */
  readonly wasAbsent: boolean;
  readonly reason?: NodeMeshErrorReason;
}

export interface SubstrateRequest {
  readonly authId: string;
  readonly machineKey: string;
  readonly nodeKey: string;
  /** Epoch ms of the publish, from the verified VM channel. */
  readonly publishedAt: number;
}

export type ApprovalResult =
  | {
      readonly outcome: "approved";
      readonly headscaleDeviceId: HeadscaleDeviceId;
      /** The design's tagged-device rule: a `substrate-gw` device never expires. */
      readonly expiryDisabled: boolean;
    }
  | {
      readonly outcome: "refused";
      readonly reason:
        | "policy_not_ready"
        | "stale"
        | "future"
        | "malformed"
        | NodeMeshErrorReason;
    }
  | {
      readonly outcome: "mismatch";
      readonly alert: typeof SUBSTRATE_MISMATCH_ALERT;
      readonly headscaleDeviceId: HeadscaleDeviceId;
      readonly tagsExact: boolean;
      readonly machineKeyMatches: boolean;
      readonly nodeKeyMatches: boolean;
      /** False when the delete itself failed; the next pass must retry it. */
      readonly deleted: boolean;
    };

export interface AttemptRef {
  readonly nodeId: string;
  readonly workload: string;
  readonly releaseId: string;
  readonly attempt: number;
}

export type MintResult =
  | {
      readonly outcome: "minted";
      readonly headscaleKeyId: HeadscaleKeyId;
      /** The key value. Store it create-once under `secretName` BEFORE the paid create. */
      readonly key: string;
      readonly secretName: string;
      /** Unstored keys of this node tag expired before the mint (log them). */
      readonly expiredOrphans: readonly HeadscaleKeyId[];
    }
  | {
      readonly outcome: "refused";
      readonly reason:
        | "policy_not_ready"
        | "sweep_pending"
        | "node_not_in_policy";
    }
  /** The mint failed or its response was lost. Nothing is stored; the sweep expires any unstored key. */
  | { readonly outcome: "failed"; readonly reason: NodeMeshErrorReason };

export type RevokeResult =
  | {
      readonly outcome: "revoked";
      readonly deletedDevices: readonly HeadscaleDeviceId[];
    }
  | { readonly outcome: "refused"; readonly reason: "not_a_node_key" }
  | {
      readonly outcome: "failed";
      /** `expire` failed: nothing was deleted. `delete` or `readback`: the key is already expired. */
      readonly stage: "expire" | "delete" | "readback";
      readonly reason: NodeMeshErrorReason | "devices_remain" | "key_live";
    };

export interface SweepResult {
  readonly ok: boolean;
  readonly expiredKeys: readonly HeadscaleKeyId[];
  readonly deletedDevices: readonly HeadscaleDeviceId[];
  readonly reason?: NodeMeshErrorReason;
}

/** Every tag is a node tag, and there is at least one. The sequencer's whole scope. */
const nodeScoped = (tags: readonly string[]): boolean =>
  tags.length > 0 && tags.every(isNodeTag);

/**
 * Headscale stamps an expire with ITS clock during the call, a moment after the caller read `now`. Our
 * keys are minted to expire in 2100, so an expiration within this slack of `now` is our expire landing.
 */
export const EXPIRY_READBACK_SLACK_MS = 60_000;

const isExpired = (expiration: string | null, now: number): boolean =>
  expiration !== null &&
  Date.parse(expiration) <= now + EXPIRY_READBACK_SLACK_MS;

const reasonOf = (error: unknown): NodeMeshErrorReason => {
  if (isNodeMeshError(error)) return error.reason;
  throw error;
};

export class MeshPlane {
  readonly owner: HeadscaleUser;
  /** The policy the last readback in this process matched; null = minting and approval are closed. */
  private matched: MeshPolicyDocument | null = null;
  /** A sweep succeeded since process start and since the last failed call. */
  private swept = false;

  constructor(
    private readonly mesh: NodeMeshPort,
    readonly env: string,
    private readonly sweepMinAgeMs: number = DEFAULT_SWEEP_MIN_AGE_MS
  ) {
    this.owner = meshOwner(env);
  }

  /** Any failed call closes minting and approval until the next good reconcile and sweep. */
  private fail(error: unknown): NodeMeshErrorReason {
    this.matched = null;
    this.swept = false;
    return reasonOf(error);
  }

  /** Mint and approve are open only after a matched readback and a sweep. */
  get mintAllowed(): boolean {
    return this.matched !== null && this.swept;
  }

  /** Create the env owner object if Headscale has none (a fresh or wiped database). */
  private async ensureOwner(): Promise<void> {
    const users = await this.mesh.listUsers();
    if (!users.some((u) => u.headscaleUser === this.owner))
      await this.mesh.createUser(this.owner);
  }

  /**
   * Read the policy; when absent or different, write deny-all and then the derivation; read back.
   * Ready only when a readback in this call equals the derivation.
   */
  async reconcilePolicy(
    grants: readonly NodeSubstrateGrant[]
  ): Promise<ReconcileResult> {
    const derived = deriveMeshPolicy({ owner: this.owner, grants });
    let wasAbsent = false;
    let drift = false;
    try {
      await this.ensureOwner();
      const read = await this.mesh.getPolicy();
      wasAbsent = read === null;
      if (read && policyMatches(read.policy, derived)) {
        this.matched = derived;
        return { outcome: "matched", ready: true, drift, wasAbsent };
      }
      drift = read !== null;
      this.matched = null;
      await this.mesh.setPolicy(serializeMeshPolicy(denyAllPolicy(this.owner)));
      await this.mesh.setPolicy(serializeMeshPolicy(derived));
      const back = await this.mesh.getPolicy();
      if (!back || !policyMatches(back.policy, derived))
        return { outcome: "readback_mismatch", ready: false, drift, wasAbsent };
      this.matched = derived;
      return { outcome: "written", ready: true, drift, wasAbsent };
    } catch (error) {
      return {
        outcome: "coordinator_failed",
        ready: false,
        drift,
        wasAbsent,
        reason: this.fail(error),
      };
    }
  }

  /** Approve the env VM's published `substrate-gw` request, then verify what Headscale registered. */
  async approveSubstrateGateway(
    request: SubstrateRequest,
    now: number
  ): Promise<ApprovalResult> {
    if (!this.matched)
      return { outcome: "refused", reason: "policy_not_ready" };
    if (
      !request.authId ||
      !request.machineKey ||
      !request.nodeKey ||
      !Number.isFinite(request.publishedAt)
    )
      return { outcome: "refused", reason: "malformed" };
    if (now - request.publishedAt > SUBSTRATE_REQUEST_MAX_AGE_MS)
      return { outcome: "refused", reason: "stale" };
    if (request.publishedAt - now > SUBSTRATE_REQUEST_MAX_SKEW_MS)
      return { outcome: "refused", reason: "future" };

    let device: MeshDevice;
    try {
      device = await this.mesh.authRegister({
        headscaleUser: this.owner,
        authId: request.authId,
      });
    } catch (error) {
      return { outcome: "refused", reason: this.fail(error) };
    }

    const tagsExact =
      device.tags.length === 1 && device.tags[0] === SUBSTRATE_TAG;
    const machineKeyMatches = device.machineKey === request.machineKey;
    const nodeKeyMatches = device.nodeKey === request.nodeKey;
    if (tagsExact && machineKeyMatches && nodeKeyMatches)
      return {
        outcome: "approved",
        headscaleDeviceId: device.headscaleDeviceId,
        expiryDisabled: device.expiry === null,
      };

    let deleted = true;
    try {
      await this.mesh.deleteNode(device.headscaleDeviceId);
    } catch (error) {
      deleted = isNodeMeshError(error) && error.reason === "node_not_found";
      if (!deleted) this.fail(error);
    }
    return {
      outcome: "mismatch",
      alert: SUBSTRATE_MISMATCH_ALERT,
      headscaleDeviceId: device.headscaleDeviceId,
      tagsExact,
      machineKeyMatches,
      nodeKeyMatches,
      deleted,
    };
  }

  /**
   * Mint the one reusable, ephemeral `tag:node-<nodeId>` key for this attempt. First expire every
   * still-usable key of this node tag that no live attempt stores (the orphan of a lost mint response),
   * so at most one usable unstored key exists at any time. Exactly one create call; a failure or a lost
   * response is reported, never retried here.
   */
  async mintAttemptKey(
    attempt: AttemptRef,
    liveKeyIds: ReadonlySet<HeadscaleKeyId>,
    now: number
  ): Promise<MintResult> {
    if (!this.matched)
      return { outcome: "refused", reason: "policy_not_ready" };
    if (!this.swept) return { outcome: "refused", reason: "sweep_pending" };
    const tag = nodeTag(attempt.nodeId);
    if (!policyNodeTags(this.matched).has(tag))
      return { outcome: "refused", reason: "node_not_in_policy" };
    const secretName = meshSecretName(attempt);
    const expiredOrphans: HeadscaleKeyId[] = [];
    try {
      for (const key of await this.mesh.listPreAuthKeys()) {
        const orphan =
          key.tags.length === 1 &&
          key.tags[0] === tag &&
          !liveKeyIds.has(key.headscaleKeyId) &&
          !isExpired(key.expiration, now);
        if (!orphan) continue;
        await this.mesh.expirePreAuthKey(key.headscaleKeyId);
        expiredOrphans.push(key.headscaleKeyId);
      }
    } catch (error) {
      return { outcome: "failed", reason: this.fail(error) };
    }
    try {
      const minted = await this.mesh.createPreAuthKey({
        tags: [tag],
        reusable: true,
        ephemeral: true,
        expiration: ATTEMPT_KEY_EXPIRATION,
      });
      return {
        outcome: "minted",
        headscaleKeyId: minted.headscaleKeyId,
        key: minted.key,
        secretName,
        expiredOrphans,
      };
    } catch (error) {
      return { outcome: "failed", reason: this.fail(error) };
    }
  }

  /** Expire every given key, then delete every node-scoped device of a key not in `live`. */
  private async expireThenDelete(
    expire: readonly HeadscaleKeyId[],
    isDoomed: (device: MeshDevice) => boolean
  ): Promise<HeadscaleDeviceId[]> {
    for (const id of expire) await this.mesh.expirePreAuthKey(id);
    const deleted: HeadscaleDeviceId[] = [];
    for (const device of await this.mesh.listNodes()) {
      if (!nodeScoped(device.tags) || !isDoomed(device)) continue;
      try {
        await this.mesh.deleteNode(device.headscaleDeviceId);
      } catch (error) {
        if (!(isNodeMeshError(error) && error.reason === "node_not_found"))
          throw error;
      }
      deleted.push(device.headscaleDeviceId);
    }
    return deleted;
  }

  /**
   * Revoke one attempt: expire its key FIRST, then delete every device that joined with it, then read
   * both back. Refuses a key that is not node-scoped.
   */
  async revokeAttempt(
    keyId: HeadscaleKeyId,
    now: number
  ): Promise<RevokeResult> {
    let stage: "expire" | "delete" | "readback" = "expire";
    try {
      const key = (await this.mesh.listPreAuthKeys()).find(
        (k) => k.headscaleKeyId === keyId
      );
      if (key && !nodeScoped(key.tags))
        return { outcome: "refused", reason: "not_a_node_key" };
      await this.mesh.expirePreAuthKey(keyId);
      stage = "delete";
      const deletedDevices = await this.expireThenDelete(
        [],
        (d) => d.headscaleKeyId === keyId
      );
      stage = "readback";
      const after = (await this.mesh.listPreAuthKeys()).find(
        (k) => k.headscaleKeyId === keyId
      );
      if (after && !isExpired(after.expiration, now))
        return { outcome: "failed", stage, reason: "key_live" };
      const remaining = (await this.mesh.listNodes()).filter(
        (d) => d.headscaleKeyId === keyId && nodeScoped(d.tags)
      );
      if (remaining.length > 0)
        return { outcome: "failed", stage, reason: "devices_remain" };
      return { outcome: "revoked", deletedDevices };
    } catch (error) {
      return { outcome: "failed", stage, reason: this.fail(error) };
    }
  }

  /**
   * Expire every node-scoped key no live attempt stores (skipping keys newer than one pass), then delete
   * every node-scoped device whose key is not live. A success opens minting again.
   */
  async sweep(
    liveKeyIds: ReadonlySet<HeadscaleKeyId>,
    now: number
  ): Promise<SweepResult> {
    const expiredKeys: HeadscaleKeyId[] = [];
    try {
      const keys = await this.mesh.listPreAuthKeys();
      const live = new Set(liveKeyIds);
      for (const key of keys) {
        if (!nodeScoped(key.tags) || live.has(key.headscaleKeyId)) continue;
        const created = key.createdAt ? Date.parse(key.createdAt) : 0;
        if (now - created < this.sweepMinAgeMs) {
          // Too new to judge: its device (if any) must survive this pass too.
          live.add(key.headscaleKeyId);
          continue;
        }
        if (!isExpired(key.expiration, now))
          expiredKeys.push(key.headscaleKeyId);
      }
      const deletedDevices = await this.expireThenDelete(
        expiredKeys,
        (d) => d.headscaleKeyId === null || !live.has(d.headscaleKeyId)
      );
      this.swept = true;
      return { ok: true, expiredKeys, deletedDevices };
    } catch (error) {
      return {
        ok: false,
        expiredKeys,
        deletedDevices: [],
        reason: this.fail(error),
      };
    }
  }

  /** HR 12: Headscale holds no API key. */
  async checkAdminSurface(): Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly apiKeys: number }
    | { readonly ok: false; readonly reason: NodeMeshErrorReason }
  > {
    try {
      const keys = await this.mesh.listApiKeys();
      return keys.length === 0
        ? { ok: true }
        : { ok: false, apiKeys: keys.length };
    } catch (error) {
      return { ok: false, reason: this.fail(error) };
    }
  }
}
