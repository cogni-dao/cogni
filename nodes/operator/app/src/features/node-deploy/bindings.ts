// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/bindings`
 * Purpose: THE ONE function that derives a consumer's connection env from a state workload's live
 *   lease: `DATABASE_URL=postgres://postgres:<pw>@<host>:<forwardedPort>/postgres?sslmode=require`
 *   (task.5400, design CD2 BIND_BY_CREDENTIAL).
 * Scope: Pure. Host and port come from the state lease's endpoints (the actuator reports forwarded
 *   ports as `tcp://host:port`); the password comes from the secret the sequencer owns. No IP allowlist.
 * Invariants:
 *   - BINDING_DERIVED_NOT_STORED: callers re-derive from the live lease on every consumer attempt,
 *     so a moved or re-forwarded port is picked up with no stored copy to go stale.
 *   - OWN_STATE_MIGRATES_ITSELF: a `DATABASE_URL` binding also yields `DATABASE_MIGRATION_URL` for the SAME
 *     state lease, so the start wrapper migrates the node's own database (task.5408).
 *   - ONE_TCP_ENDPOINT: a state lease must expose exactly one forwarded tcp endpoint; zero or several
 *     is a refusal, never a guess.
 *   - ONE_SUBSTRATE_BINDING (task.5432, CD2): `resolveSubstrateBinding` is the one output that names the
 *     host and ports a consumer reaches the env's shared services on. The env injection and the mesh grant
 *     (`NodeSubstrateGrant.ports`, the companion listeners) both read it; nobody derives them again.
 *   - MESH_HOST_IS_THE_COMPANION: on the `mesh` transport the host is `cogni-substrate`, the private
 *     companion in the same lease. No VM host and no mesh identifier or credential is in the output.
 *   - CREDENTIAL_FROM_THE_BUCKET_ENDPOINT_FROM_THE_BINDING: `rebindDsnEndpoint` keeps the bucket DSN's own
 *     user, password, database and query byte for byte and replaces only host and port. It never borrows
 *     another database's DSN and never changes `sslmode` (no TLS claim).
 * Side-effects: none
 * @internal
 */

import {
  portsForTypes,
  SUBSTRATE_PORTS,
  type SubstrateType,
} from "./substrate-ports";

export interface StateBindingInput {
  readonly name: string;
  readonly endpoints: readonly string[];
  readonly password: string;
}

export interface ResolvedBinding {
  readonly env: string;
  readonly value: string;
  readonly host: string;
  readonly port: number;
}

const TCP_ENDPOINT = /^tcp:\/\/([a-zA-Z0-9.-]+):(\d{1,5})$/;

/** Parse the single forwarded tcp endpoint of a state lease. Throws on zero or several. */
export function forwardedTcpEndpoint(endpoints: readonly string[]): {
  host: string;
  port: number;
} {
  const matches = endpoints
    .map((e) => TCP_ENDPOINT.exec(e))
    .filter((m): m is RegExpExecArray => m !== null);
  if (matches.length !== 1) {
    throw new Error(
      `binding: expected exactly one forwarded tcp endpoint, found ${matches.length} in ${JSON.stringify(endpoints)}`
    );
  }
  const m = matches[0] as RegExpExecArray;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`binding: forwarded port out of range: ${m[2]}`);
  return { host: m[1] as string, port };
}

/**
 * Resolve every binding of `consumer` that targets `state` into env entries.
 * Bindings that target another workload are ignored here (the caller resolves each state once).
 */
export function resolveBinding(
  consumer: {
    readonly bindings: readonly {
      readonly env: string;
      readonly workload: string;
    }[];
  },
  state: StateBindingInput
): readonly ResolvedBinding[] {
  const targeted = consumer.bindings.filter((b) => b.workload === state.name);
  if (targeted.length === 0) return [];
  const { host, port } = forwardedTcpEndpoint(state.endpoints);
  const url = `postgres://postgres:${encodeURIComponent(state.password)}@${host}:${port}/postgres?sslmode=require`;
  return targeted.flatMap((b) =>
    b.env === "DATABASE_URL"
      ? [
          { env: b.env, value: url, host, port },
          // OWN_STATE_MIGRATES_ITSELF (task.5408): a node whose database is its own state lease migrates
          // that database, with the same derived DSN, before it serves. The shared bucket's migration
          // DSN names another database and is never sent here.
          { env: "DATABASE_MIGRATION_URL", value: url, host, port },
        ]
      : [{ env: b.env, value: url, host, port }]
  );
}

/**
 * How an attempt reaches the env's shared services (design: node-service-delivery, connectivity decision).
 * `egress`: the env VM host, admitted by the provider's egress address (today). `mesh`: the private
 * `cogni-substrate` companion, admitted by device identity. The sequencer chooses it per attempt.
 */
export type SubstrateTransport = "egress" | "mesh";

/** The private companion's service name in a mesh lease: the one host a mesh attempt's env names. */
export const MESH_SUBSTRATE_HOST = "cogni-substrate";

/** The one binding of a consumer to the env's shared services. Carries no secret and no mesh identifier. */
export interface SubstrateBinding {
  readonly transport: SubstrateTransport;
  /** `egress`: the env VM alias. `mesh`: `cogni-substrate`. */
  readonly host: string;
  /** The shared services the consumer reaches on `host`, in registry order. */
  readonly types: readonly SubstrateType[];
  /** `portsForTypes(types)`: the mesh grant and the companion listeners. */
  readonly ports: readonly number[];
}

export interface SubstrateBindingInput {
  readonly transport: SubstrateTransport;
  /** The env VM alias. Required for `egress`; ignored for `mesh`. */
  readonly vmHost?: string | undefined;
  /** The shared services the consumer uses. */
  readonly types: readonly SubstrateType[];
}

const REGISTRY_ORDER = Object.keys(SUBSTRATE_PORTS) as SubstrateType[];

/**
 * Resolve a consumer's substrate binding. `undefined` = no binding: an egress attempt with no VM host
 * (composition parity: the whole substrate block is omitted). A mesh attempt always binds.
 */
export function resolveSubstrateBinding(
  input: SubstrateBindingInput
): SubstrateBinding | undefined {
  const wanted = new Set(input.types);
  for (const t of wanted)
    if (!Object.hasOwn(SUBSTRATE_PORTS, t))
      throw new Error(`substrate binding: not a registry type: ${String(t)}`);
  const types = REGISTRY_ORDER.filter((t) => wanted.has(t));
  if (input.transport === "mesh")
    return {
      transport: "mesh",
      host: MESH_SUBSTRATE_HOST,
      types,
      ports: portsForTypes(types),
    };
  if (input.transport !== "egress")
    throw new Error(
      `substrate binding: unknown transport: ${String(input.transport)}`
    );
  if (!input.vmHost) return undefined;
  return {
    transport: "egress",
    host: input.vmHost,
    types,
    ports: portsForTypes(types),
  };
}

/** `postgres[ql]://<userinfo>@<host>[:port]/<database>[?query][#fragment]`. Userinfo is required. */
const POSTGRES_DSN =
  /^(postgres(?:ql)?:\/\/[^@/?#\s]+@)(\[[0-9a-fA-F:.]+\]|[^/?#:@[\]\s]+)(?::\d{1,5})?(\/[^/?#\s]+(?:[?#][^\s]*)?)$/;

/**
 * The host of a Postgres-wire DSN, lowercased (`undefined` when the DSN has another shape). It reads no
 * credential into its result.
 */
export function dsnHost(dsn: string): string | undefined {
  return POSTGRES_DSN.exec(dsn)?.[2]?.toLowerCase();
}

const IPV4 =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/**
 * One comparable form of a host: lowercase; IPv6 without brackets in its canonical compressed form (WHATWG
 * URL serializer); IPv4 only in strict dotted-quad form (no leading zeros). `undefined` for an invalid
 * address, which then matches nothing.
 */
export function normalizeHost(host: string): string | undefined {
  const h = host.trim().toLowerCase();
  if (h.length === 0) return undefined;
  const bare = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  if (bare.includes(":")) {
    try {
      return new URL(`http://[${bare}]/`).hostname.slice(1, -1);
    } catch {
      return undefined;
    }
  }
  if (/^[\d.]+$/.test(bare)) return IPV4.test(bare) ? bare : undefined;
  return bare;
}

/**
 * SHARED_VM_MATCH (task.5432): `host` is the lane's substrate (env VM) host when it equals the lane host
 * NAME or one of that name's resolved ADDRESSES, compared in normalized form. With no addresses only the
 * name matches (fail safe: no rebind). A host that matches neither, such as a dedicated cell, never does.
 */
export function isSubstrateVmHost(
  host: string,
  vmHost: string | undefined,
  vmAddresses: readonly string[] = []
): boolean {
  const h = normalizeHost(host);
  if (h === undefined) return false;
  return [vmHost, ...vmAddresses].some(
    (c) => c !== undefined && normalizeHost(c) === h
  );
}

/**
 * Replace ONLY the endpoint of a Postgres-wire DSN. The credential, database and query stay byte for
 * byte (the bucket keeps the credential; the binding owns the endpoint). Throws on any other shape.
 */
export function rebindDsnEndpoint(
  dsn: string,
  host: string,
  port: number
): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`dsn rebind: port out of range: ${port}`);
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(host))
    throw new Error(`dsn rebind: host is not a plain name: ${host}`);
  const m = POSTGRES_DSN.exec(dsn);
  if (!m)
    throw new Error(
      "dsn rebind: not a postgres DSN with a credential and a database"
    );
  return `${m[1]}${host}:${port}${m[3]}`;
}
