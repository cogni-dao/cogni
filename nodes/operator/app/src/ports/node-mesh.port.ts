// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@ports/node-mesh`
 * Purpose: What the node-deploy sequencer needs from ONE environment's Headscale coordinator
 *   (task.5429, connectivity decision task.5384): the derived policy, attempt-scoped pre-auth keys,
 *   devices, the `substrate-gw` approval and the env's Headscale owner object.
 * Scope: Interface, provider-id types and one error class. Does not perform IO.
 * Invariants:
 *   - PROVIDER_IDS_ARE_NAMESPACED: Headscale ids are provider ids, never Cogni identity (identity-model).
 *     They are `headscaleKeyId`, `headscaleDeviceId` and `headscaleUser` wherever they are stored or
 *     passed; nothing here is a `user_id`, `tenant_id` or billing key.
 *   - NO_ADMIN_SURFACE (HR 12): the port has no call that creates an API key. `listApiKeys` exists only so
 *     the sequencer can prove there are zero.
 *   - SECRET_ONLY_ON_MINT: only `createPreAuthKey` returns a usable key value; every list returns ids and
 *     metadata, never a key.
 *   - NOT_FOUND_IS_NULL: a Headscale with no stored policy (`acl policy not found`) is `null` from
 *     `getPolicy`, never an error, so the caller can seed deny-all (HR 4).
 *   - NORMALIZED_ERRORS: every failure is a `NodeMeshError` with a closed `code` and `reason`; its message
 *     never carries a request or response payload.
 * Side-effects: none
 * Links: adapters/server/node-deploy/headscale.adapter.ts, features/node-deploy/mesh-plane.ts
 * @public
 */

declare const headscaleKeyIdBrand: unique symbol;
declare const headscaleDeviceIdBrand: unique symbol;
declare const headscaleUserBrand: unique symbol;

/** A Headscale pre-auth key id (uint64 as a decimal string). A provider id, never a Cogni identity. */
export type HeadscaleKeyId = string & { readonly [headscaleKeyIdBrand]: true };
/** A Headscale node (device) id (uint64 as a decimal string). A provider id, never a Cogni identity. */
export type HeadscaleDeviceId = string & {
  readonly [headscaleDeviceIdBrand]: true;
};
/** The env's Headscale owner object name, `cogni-mesh-<env>`. Never read as `user_id`. */
export type HeadscaleUser = string & { readonly [headscaleUserBrand]: true };

export const headscaleKeyId = (raw: string): HeadscaleKeyId =>
  raw as HeadscaleKeyId;
export const headscaleDeviceId = (raw: string): HeadscaleDeviceId =>
  raw as HeadscaleDeviceId;
export const headscaleUser = (raw: string): HeadscaleUser =>
  raw as HeadscaleUser;

/** The stored policy text exactly as Headscale returns it. */
export interface MeshPolicy {
  readonly policy: string;
  /** ISO-8601, or null when Headscale did not send one. */
  readonly updatedAt: string | null;
}

export interface MeshUser {
  readonly headscaleUser: HeadscaleUser;
  readonly createdAt: string | null;
}

/** Key metadata. Never carries the key value. */
export interface MeshPreAuthKey {
  readonly headscaleKeyId: HeadscaleKeyId;
  readonly tags: readonly string[];
  readonly reusable: boolean;
  readonly ephemeral: boolean;
  readonly used: boolean;
  /** ISO-8601. A key whose expiration is in the past is expired. */
  readonly expiration: string | null;
  readonly createdAt: string | null;
}

/** The one place a key value exists: the mint response. Store it create-once before using it. */
export interface MintedPreAuthKey extends MeshPreAuthKey {
  readonly key: string;
}

export interface MeshDevice {
  readonly headscaleDeviceId: HeadscaleDeviceId;
  readonly name: string;
  readonly givenName: string;
  readonly machineKey: string;
  readonly nodeKey: string;
  readonly tags: readonly string[];
  readonly online: boolean;
  /** The key the device joined with; null for a device approved by `authRegister`. */
  readonly headscaleKeyId: HeadscaleKeyId | null;
  /** The owner object, when the device is user-owned (tagged devices carry none). */
  readonly headscaleUser: HeadscaleUser | null;
  readonly createdAt: string | null;
  readonly lastSeen: string | null;
  /** ISO-8601 key expiry; null means the device never expires (the design's tagged-device rule). */
  readonly expiry: string | null;
}

export interface MeshApiKey {
  readonly headscaleApiKeyId: string;
  readonly createdAt: string | null;
  readonly expiration: string | null;
}

export interface CreatePreAuthKeyInput {
  /** Every tag must start with `tag:`. Node keys carry exactly `[tag:node-<nodeId>]`. */
  readonly tags: readonly string[];
  readonly reusable: boolean;
  readonly ephemeral: boolean;
  /**
   * Required. Headscale v0.29.7 stores an absent expiration as the zero time, so a key minted without
   * one is born expired. "No time ceiling" is a far-future date that the attempt close expires early.
   */
  readonly expiration: Date;
}

export interface NodeMeshPort {
  /** Headscale's own health read (`database_connectivity`). */
  health(): Promise<{ readonly databaseConnectivity: boolean }>;
  /** The stored policy; null when Headscale has none (fresh or wiped database). */
  getPolicy(): Promise<MeshPolicy | null>;
  /** Replace the whole policy (database mode). Returns what Headscale stored. */
  setPolicy(policy: string): Promise<MeshPolicy>;
  createUser(name: HeadscaleUser): Promise<MeshUser>;
  listUsers(): Promise<readonly MeshUser[]>;
  createPreAuthKey(input: CreatePreAuthKeyInput): Promise<MintedPreAuthKey>;
  /** Idempotent: expiring an expired or unknown key succeeds. */
  expirePreAuthKey(id: HeadscaleKeyId): Promise<void>;
  listPreAuthKeys(): Promise<readonly MeshPreAuthKey[]>;
  listNodes(): Promise<readonly MeshDevice[]>;
  deleteNode(id: HeadscaleDeviceId): Promise<void>;
  /** Approve a pending interactive registration (Headscale `AuthRegister`). No inspect-before-approve. */
  authRegister(input: {
    readonly headscaleUser: HeadscaleUser;
    readonly authId: string;
  }): Promise<MeshDevice>;
  listApiKeys(): Promise<readonly MeshApiKey[]>;
}

/**
 * The attempt-key Secret name allow-list (hub node-service-delivery section 3), the same expression the
 * admission policy allows a sequencer DELETE for. `features/node-deploy/mesh-plane.ts` derives names that
 * match it; a unit test keeps the two equal.
 */
export const MESH_ATTEMPT_SECRET_NAME_RE =
  /^nd-[0-9a-f]{8}-[a-z0-9-]+-mesh-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-a[0-9]+$/;

/** What one attempt's create-once Secret holds: the key value and its provider id. */
export interface StoredMeshKey {
  readonly key: string;
  readonly headscaleKeyId: HeadscaleKeyId;
}

/**
 * The attempt-key store (task.5431, hub node-service-delivery section 3): a create-once Kubernetes Secret
 * `nd-<nodeId8>-<workload>-mesh-<releaseId>-a<attempt>` in the env's `cogni-node-deploy-<env>`
 * namespace, the merged state-secret precedent.
 * Invariants:
 *   - CREATE_ONCE: `createOnce` never overwrites; a racing writer's value is returned instead.
 *   - NAME_IS_ADMISSIBLE: every name must match the admission policy's delete allow-list, so a state
 *     password can never be named here (and so never deleted here).
 *   - DELETE_IS_IDEMPOTENT: deleting an absent Secret succeeds.
 *   - NO_VALUES_IN_LOGS.
 */
export interface MeshKeyStorePort {
  get(name: string): Promise<StoredMeshKey | undefined>;
  createOnce(name: string, value: StoredMeshKey): Promise<StoredMeshKey>;
  delete(name: string): Promise<void>;
}

/** The `substrate-gw` enrollment request its env VM publishes over the verified DNS-only channel. */
export interface PublishedSubstrateRequest {
  readonly authId: string;
  readonly machineKey: string;
  readonly nodeKey: string;
  /** Epoch ms of the publish. */
  readonly publishedAt: number;
}

/**
 * Reads the env VM's published `substrate-gw` request over HTTPS with public certificate and host-name
 * verification (HR 11). `null` = nothing to approve (no file, or the device is already registered and
 * publishes no auth id). A transport or parse failure throws.
 */
export interface SubstrateRequestSourcePort {
  read(): Promise<PublishedSubstrateRequest | null>;
}

export type NodeMeshErrorCode =
  /** The socket is absent or refused the connection. */
  | "unavailable"
  /** The call ran past its deadline. The write may or may not have happened. */
  | "timeout"
  | "not_found"
  | "invalid_argument"
  | "failed_precondition"
  | "unknown";

/** A closed set of Headscale answers the caller acts on. Anything else is `other`. */
export type NodeMeshErrorReason =
  | "policy_not_found"
  | "authkey_expired"
  | "user_not_found"
  | "node_not_found"
  | "registration_not_found"
  | "policy_invalid"
  | "policy_update_disabled"
  | "other";

export class NodeMeshError extends Error {
  constructor(
    readonly method: string,
    readonly code: NodeMeshErrorCode,
    readonly reason: NodeMeshErrorReason
  ) {
    super(`headscale ${method} failed: ${code} (${reason})`);
    this.name = "NodeMeshError";
  }
}

export const isNodeMeshError = (error: unknown): error is NodeMeshError =>
  error instanceof NodeMeshError;
