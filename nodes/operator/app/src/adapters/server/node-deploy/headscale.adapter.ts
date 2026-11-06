// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/node-deploy/headscale.adapter`
 * Purpose: The sequencer's client for ONE env's Headscale v0.29.7 (task.5429): gRPC over Headscale's
 *   pod-local unix socket, the stock path Headscale's own CLI uses.
 * Scope: Wire mapping and bounded IO only. Does not derive policy, order calls or check approvals; that lives in
 *   `features/node-deploy/mesh-plane.ts`.
 * Invariants:
 *   - SOCKET_ONLY_NO_API_KEY (HR 12): the only transport is `unix:<socketPath>` with no call credentials.
 *     Headscale serves gRPC on that socket without authentication (hscontrol/app.go, `grpcSocket`); its
 *     REST gateway lives on the HTTP listener behind an API key, which this client never uses.
 *   - PINNED_SCHEMA: messages come from `HEADSCALE_V0_29_7_DESCRIPTOR`, drift-pinned to the vendored
 *     v0.29.7 protos. No `.proto` file is read at run time, so the bundled sequencer works.
 *   - BOUNDED: every call carries a gRPC deadline (`timeoutMs`, default 5 s), and reconnect backoff is
 *     capped at 3 s so a restarted Headscale is reached on the next pass.
 *   - NORMALIZED_ERRORS: every failure is a `NodeMeshError` (closed code + reason). Neither a request
 *     payload (policy, key) nor Headscale's raw message is put in the error.
 *   - NO_VALUES_IN_LOGS: this module never logs; the minted key value is returned once to the caller.
 * Side-effects: IO (unix-socket gRPC)
 * Links: ports/node-mesh.port.ts, headscale-v0.29.7.descriptor.ts,
 *   https://github.com/juanfont/headscale/blob/v0.29.7/hscontrol/app.go
 * @internal
 */

import {
  type Client,
  credentials,
  loadPackageDefinition,
  type ServiceClientConstructor,
  type ServiceError,
  status,
} from "@grpc/grpc-js";
import { fromJSON } from "@grpc/proto-loader";

import {
  type CreatePreAuthKeyInput,
  type HeadscaleDeviceId,
  type HeadscaleKeyId,
  type HeadscaleUser,
  headscaleDeviceId,
  headscaleKeyId,
  headscaleUser,
  type MeshApiKey,
  type MeshDevice,
  type MeshPolicy,
  type MeshPreAuthKey,
  type MeshUser,
  type MintedPreAuthKey,
  NodeMeshError,
  type NodeMeshErrorCode,
  type NodeMeshErrorReason,
  type NodeMeshPort,
} from "@/ports";

import {
  HEADSCALE_V0_29_7_DESCRIPTOR,
  type HeadscaleClientMethod,
} from "./headscale-v0.29.7.descriptor";

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Headscale restarts with every sequencer rollout (design CD5). grpc-js backs off up to 120 s by default;
 * a few seconds keeps the first pass after a restart from failing on a stale backoff.
 */
export const CHANNEL_OPTIONS = {
  "grpc.initial_reconnect_backoff_ms": 500,
  "grpc.max_reconnect_backoff_ms": 3_000,
} as const;

/** The JSON literal is plain data; protobufjs' INamespace marks optional members as required. */
export const HEADSCALE_DESCRIPTOR =
  HEADSCALE_V0_29_7_DESCRIPTOR as unknown as Parameters<typeof fromJSON>[0];

/** Wire shapes (keepCase, longs and enums as strings, defaults filled). */
interface WireTimestamp {
  readonly seconds?: string;
  readonly nanos?: number;
}
interface WireUser {
  readonly id?: string;
  readonly name?: string;
  readonly created_at?: WireTimestamp | null;
}
interface WirePreAuthKey {
  readonly id?: string;
  readonly key?: string;
  readonly reusable?: boolean;
  readonly ephemeral?: boolean;
  readonly used?: boolean;
  readonly expiration?: WireTimestamp | null;
  readonly created_at?: WireTimestamp | null;
  readonly acl_tags?: readonly string[];
}
interface WireNode {
  readonly id?: string;
  readonly machine_key?: string;
  readonly node_key?: string;
  readonly name?: string;
  readonly given_name?: string;
  readonly user?: WireUser | null;
  readonly last_seen?: WireTimestamp | null;
  readonly expiry?: WireTimestamp | null;
  readonly pre_auth_key?: WirePreAuthKey | null;
  readonly created_at?: WireTimestamp | null;
  readonly online?: boolean;
  readonly tags?: readonly string[];
}
interface WireApiKey {
  readonly id?: string;
  readonly expiration?: WireTimestamp | null;
  readonly created_at?: WireTimestamp | null;
}
interface WirePolicy {
  readonly policy?: string;
  readonly updated_at?: WireTimestamp | null;
}

type UnaryFn = (
  request: object,
  options: { deadline: Date },
  callback: (error: ServiceError | null, response?: unknown) => void
) => unknown;

/** `timestamppb.New(time.Time{})`: Go's zero time, 0001-01-01T00:00:00Z. */
export const GO_ZERO_TIME_SECONDS = -62_135_596_800;
/** The past instant a zero key expiration maps to: such a key is already expired in Headscale. */
const EXPIRED_AT_ZERO = new Date(0).toISOString();

/**
 * A protobuf Timestamp as ISO-8601. Absent, the proto3 default (0 s) and Go's zero time all mean
 * "unset" and map to null, except where `zero: "expired"`: Headscale v0.29.7 treats a pre-auth key whose
 * expiration is the zero time as expired (`types/preauth_key.go` Validate), so that maps to a past instant.
 */
export const timestampToIso = (
  ts: WireTimestamp | null | undefined,
  zero: "null" | "expired" = "null"
): string | null => {
  if (!ts) return null;
  const seconds = Number(ts.seconds ?? 0);
  const nanos = ts.nanos ?? 0;
  if ((seconds === 0 && nanos === 0) || seconds <= GO_ZERO_TIME_SECONDS)
    return zero === "expired" ? EXPIRED_AT_ZERO : null;
  const ms = seconds * 1000 + Math.floor(nanos / 1e6);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

const toTimestamp = (date: Date): WireTimestamp & { seconds: string } => {
  const ms = date.getTime();
  const seconds = Math.floor(ms / 1000);
  return { seconds: String(seconds), nanos: (ms - seconds * 1000) * 1e6 };
};

const CODES: Partial<Record<number, NodeMeshErrorCode>> = {
  [status.UNAVAILABLE]: "unavailable",
  [status.DEADLINE_EXCEEDED]: "timeout",
  [status.NOT_FOUND]: "not_found",
  [status.INVALID_ARGUMENT]: "invalid_argument",
  [status.FAILED_PRECONDITION]: "failed_precondition",
};

/** Ordered: the more specific Headscale answer first. Matched on Headscale's message, never stored. */
const REASONS: ReadonlyArray<readonly [string, NodeMeshErrorReason]> = [
  ["acl policy not found", "policy_not_found"],
  ["authkey expired", "authkey_expired"],
  ["registration cache", "registration_not_found"],
  ["user not found", "user_not_found"],
  ["node not found", "node_not_found"],
  ["update is disabled", "policy_update_disabled"],
  ["setting policy", "policy_invalid"],
  ["parsing", "policy_invalid"],
];

/** Map any client failure to a payload-free `NodeMeshError`. */
export const normalizeError = (
  method: string,
  error: unknown
): NodeMeshError => {
  const e = error as Partial<ServiceError> | undefined;
  const code: NodeMeshErrorCode =
    (typeof e?.code === "number" ? CODES[e.code] : undefined) ?? "unknown";
  const detail = `${e?.details ?? ""}`.toLowerCase();
  const reason =
    REASONS.find(([needle]) => detail.includes(needle))?.[1] ?? "other";
  return new NodeMeshError(method, code, reason);
};

const toUser = (u: WireUser): MeshUser => ({
  headscaleUser: headscaleUser(u.name ?? ""),
  createdAt: timestampToIso(u.created_at),
});

const toKey = (k: WirePreAuthKey): MeshPreAuthKey => ({
  headscaleKeyId: headscaleKeyId(String(k.id ?? "")),
  tags: [...(k.acl_tags ?? [])],
  reusable: k.reusable ?? false,
  ephemeral: k.ephemeral ?? false,
  used: k.used ?? false,
  expiration: timestampToIso(k.expiration, "expired"),
  createdAt: timestampToIso(k.created_at),
});

/**
 * Headscale renders a tag-owned node with the synthetic user `tagged-devices`, id 2147455555
 * (`types/users.go` TaggedDevices). It is not an owner object, so it maps to null.
 */
export const TAGGED_DEVICES_USER_ID = "2147455555";

const toDevice = (n: WireNode): MeshDevice => ({
  headscaleDeviceId: headscaleDeviceId(String(n.id ?? "")),
  name: n.name ?? "",
  givenName: n.given_name ?? "",
  machineKey: n.machine_key ?? "",
  nodeKey: n.node_key ?? "",
  tags: [...(n.tags ?? [])],
  online: n.online ?? false,
  headscaleKeyId:
    n.pre_auth_key?.id && n.pre_auth_key.id !== "0"
      ? headscaleKeyId(String(n.pre_auth_key.id))
      : null,
  headscaleUser:
    n.user?.name && n.user.id !== TAGGED_DEVICES_USER_ID
      ? headscaleUser(n.user.name)
      : null,
  createdAt: timestampToIso(n.created_at),
  lastSeen: timestampToIso(n.last_seen),
  expiry: timestampToIso(n.expiry),
});

const toPolicy = (p: WirePolicy): MeshPolicy => ({
  policy: p.policy ?? "",
  updatedAt: timestampToIso(p.updated_at),
});

export interface HeadscaleAdapterOptions {
  /** Absolute path of the env Headscale's unix socket (shared through a pod-local volume). */
  readonly socketPath: string;
  readonly timeoutMs?: number;
}

/** Build the generated service client constructor once per process. */
let serviceCtor: ServiceClientConstructor | undefined;
const headscaleServiceCtor = (): ServiceClientConstructor => {
  if (serviceCtor) return serviceCtor;
  const definition = fromJSON(HEADSCALE_DESCRIPTOR, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const pkg = loadPackageDefinition(definition) as unknown as {
    headscale: { v1: { HeadscaleService: ServiceClientConstructor } };
  };
  serviceCtor = pkg.headscale.v1.HeadscaleService;
  return serviceCtor;
};

export class HeadscaleSocketAdapter implements NodeMeshPort {
  private readonly client: Client;
  private readonly timeoutMs: number;

  constructor(options: HeadscaleAdapterOptions) {
    if (!options.socketPath.startsWith("/"))
      throw new Error("headscale socketPath must be an absolute path");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const Ctor = headscaleServiceCtor();
    this.client = new Ctor(
      `unix:${options.socketPath}`,
      credentials.createInsecure(),
      CHANNEL_OPTIONS
    );
  }

  /** Release the socket channel. */
  close(): void {
    this.client.close();
  }

  private call<T>(method: HeadscaleClientMethod, request: object): Promise<T> {
    const fn = (this.client as unknown as Record<string, UnaryFn>)[method];
    if (typeof fn !== "function")
      return Promise.reject(new NodeMeshError(method, "unknown", "other"));
    return new Promise<T>((resolve, reject) => {
      fn.call(
        this.client,
        request,
        { deadline: new Date(Date.now() + this.timeoutMs) },
        (error, response) => {
          if (error) reject(normalizeError(method, error));
          else resolve((response ?? {}) as T);
        }
      );
    });
  }

  async health(): Promise<{ readonly databaseConnectivity: boolean }> {
    const r = await this.call<{ database_connectivity?: boolean }>(
      "Health",
      {}
    );
    return { databaseConnectivity: r.database_connectivity ?? false };
  }

  async getPolicy(): Promise<MeshPolicy | null> {
    try {
      return toPolicy(await this.call<WirePolicy>("GetPolicy", {}));
    } catch (error) {
      if (error instanceof NodeMeshError && error.reason === "policy_not_found")
        return null;
      throw error;
    }
  }

  async setPolicy(policy: string): Promise<MeshPolicy> {
    return toPolicy(await this.call<WirePolicy>("SetPolicy", { policy }));
  }

  async createUser(name: HeadscaleUser): Promise<MeshUser> {
    const r = await this.call<{ user?: WireUser }>("CreateUser", { name });
    if (!r.user) throw new NodeMeshError("CreateUser", "unknown", "other");
    return toUser(r.user);
  }

  async listUsers(): Promise<readonly MeshUser[]> {
    const r = await this.call<{ users?: WireUser[] }>("ListUsers", {});
    return (r.users ?? []).map(toUser);
  }

  async createPreAuthKey(
    input: CreatePreAuthKeyInput
  ): Promise<MintedPreAuthKey> {
    const r = await this.call<{ pre_auth_key?: WirePreAuthKey }>(
      "CreatePreAuthKey",
      {
        // 0 = no owning user: a tagged key is owned by its tags (headscale db.CreatePreAuthKey).
        user: "0",
        reusable: input.reusable,
        ephemeral: input.ephemeral,
        expiration: toTimestamp(input.expiration),
        acl_tags: [...input.tags],
      }
    );
    const k = r.pre_auth_key;
    // defaults:true decodes a missing uint64 as "0"; Headscale never issues id 0.
    if (!k?.key || !k.id || k.id === "0")
      throw new NodeMeshError("CreatePreAuthKey", "unknown", "other");
    return { ...toKey(k), key: k.key };
  }

  async expirePreAuthKey(id: HeadscaleKeyId): Promise<void> {
    await this.call("ExpirePreAuthKey", { id });
  }

  async listPreAuthKeys(): Promise<readonly MeshPreAuthKey[]> {
    const r = await this.call<{ pre_auth_keys?: WirePreAuthKey[] }>(
      "ListPreAuthKeys",
      {}
    );
    return (r.pre_auth_keys ?? []).map(toKey);
  }

  async listNodes(): Promise<readonly MeshDevice[]> {
    const r = await this.call<{ nodes?: WireNode[] }>("ListNodes", {});
    return (r.nodes ?? []).map(toDevice);
  }

  async deleteNode(id: HeadscaleDeviceId): Promise<void> {
    await this.call("DeleteNode", { node_id: id });
  }

  async authRegister(input: {
    readonly headscaleUser: HeadscaleUser;
    readonly authId: string;
  }): Promise<MeshDevice> {
    const r = await this.call<{ node?: WireNode }>("AuthRegister", {
      user: input.headscaleUser,
      auth_id: input.authId,
    });
    if (!r.node) throw new NodeMeshError("AuthRegister", "unknown", "other");
    return toDevice(r.node);
  }

  async listApiKeys(): Promise<readonly MeshApiKey[]> {
    const r = await this.call<{ api_keys?: WireApiKey[] }>("ListApiKeys", {});
    return (r.api_keys ?? []).map((k) => ({
      headscaleApiKeyId: String(k.id ?? ""),
      createdAt: timestampToIso(k.created_at),
      expiration: timestampToIso(k.expiration),
    }));
  }
}
