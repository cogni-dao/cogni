// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/node-app-env`
 * Purpose: The runtime env a node APP workload receives from the node-deploy sequencer — the SAME env
 *   the retired Crossplane lane rendered for the `cogni-node-app-v1` service
 *   (`infra/crossplane/xcomputeworkload/composition.yaml`, the `$isApp` blocks), with OpenBao as the
 *   custodian of every secret value (task.5405, story.5127).
 * Scope: Pure. The caller reads the node's bucket (`NodeRuntimeSecretsPort`) and the catalog row; this
 *   module only decides WHICH keys become env and WHAT each non-secret value is.
 * Invariants:
 *   - COMPOSITION_PARITY: the key set, the values and the precedence match the composition, in this
 *     order (later wins): HOST/HOSTNAME/PORT, APP_ENV, DEPLOY_ENVIRONMENT, COGNI_REPO_SHA, substrate
 *     topology (only with a substrate host), secrets, COGNI_NODE_ID, database pool maxes, Loki push
 *     (opt-in), then the identity block (NODE_NAME, COGNI_REPO_PATH, AUTH_TRUST_HOST, NEXTAUTH_URL,
 *     APP_BASE_URL) which wins over everything above. `node-app-env.test.ts` pins this key by key.
 *   - MIGRATION_DSN (task.5408): DATABASE_MIGRATION_URL is read from the bucket for every node app, unless
 *     its DATABASE_URL is bound to its own state lease; then the binding supplies it (bindings.ts
 *     OWN_STATE_MIGRATES_ITSELF). The start wrapper migrates with it and unsets it.
 *   - DECLARED_KEYS_ONLY: the secrets injected are EXACTLY the release's declared key list
 *     (`NodeWorkloadSpec.secretKeys` = the profile keys + the node's declared `secret_refs`, computed at
 *     lowering from its repo-spec at the source sha). A key that is merely present in the node's bucket
 *     (fleet-inherited `GH_WEBHOOK_SECRET`, `POSTHOG_API_KEY`, `TAVILY_API_KEY`, ...) is never delivered.
 *     Operator/fleet credentials on `OFF_CLUSTER_WORKLOAD_DENIED_KEYS` are refused even if declared.
 *   - DECLARED_KEYS_FAIL_CLOSED: every declared key must be present and non-empty, else this throws and
 *     the caller deploys NOTHING (never a half env), exactly like the composition's fail-closed
 *     placeholders. A key the node binds to a state workload (CD2: the declared binding overrides) is not
 *     required from the bucket.
 *   - LITELLM_KEY_RENAME: the node-scoped `LITELLM_VIRTUAL_KEY` is delivered as `LITELLM_MASTER_KEY`
 *     and is NOT also passed under its own name (byte-identical to the composition). The fleet master
 *     key is on the denylist and can never arrive through the bucket.
 *   - NO_NODE_NAMES: nothing here names a node.
 *   - ONE_SUBSTRATE_BINDING (task.5432, CD2): the substrate block and the Doltgres endpoint come from
 *     `nodeAppSubstrateBinding`, the same output the sequencer gives the mesh grant and the companion
 *     listeners. Ports come only from `substrate-ports.ts`; this file spells no port.
 *   - MESH_ENV (task.5432): on a `mesh` attempt the substrate host is `cogni-substrate`, `DOLTGRES_URL`
 *     keeps the bucket credential and database with the binding's host and port, and no port without a
 *     mesh grant is injected (the egress-only scheduler-worker health URL is omitted). The key set
 *     otherwise equals the egress key set: no mesh identifier or credential reaches the app. Postgres DSNs
 *     keep their bucket endpoint: their host is placement-owned (shared VM or dedicated cell).
 *   - EGRESS_UNCHANGED: an absent transport is `egress`, byte for byte the composition env above.
 * Side-effects: none
 * Links: infra/crossplane/xcomputeworkload/composition.yaml, packages/repo-spec/src/node-app-deployment.ts,
 *   shared/secrets/node-secrets-reserved.data.ts, task.5405
 * @internal
 */

import { resolveRuntimeProfileSecretRefs } from "@cogni/repo-spec";

import { isOffClusterWorkloadSecretKey } from "@/shared/secrets/node-secrets-reserved.data";

import {
  rebindDsnEndpoint,
  resolveSubstrateBinding,
  type SubstrateBinding,
  type SubstrateTransport,
} from "./bindings";
import {
  EGRESS_ONLY_PORTS,
  SUBSTRATE_PORTS,
  type SubstrateType,
} from "./substrate-ports";

/** Database pool maxes from the node's catalog `database.<env>.runtimePoolLimits` (public policy). */
export interface NodeAppPoolLimits {
  readonly app: number;
  readonly service: number;
  readonly read: number;
  readonly replicaCount: number;
}

/** The three opt-in Loki lease-push credentials (composition `$logPush`). */
export interface NodeAppLokiPush {
  readonly url: string;
  readonly user: string;
  readonly password: string;
}

export interface NodeAppEnvInput {
  /** Deployment environment (`candidate-a` | `preview` | `production`). */
  readonly env: string;
  /** The node's slug (`NODE_NAME`). */
  readonly slug: string;
  readonly nodeId: string;
  /** The release's source sha (`COGNI_REPO_SHA`). */
  readonly sourceSha: string;
  /** Public host of the app (no scheme). */
  readonly publicHost: string;
  /** Trusted public operator issuer host for this workload lane. */
  readonly operatorDomain: string;
  /** The container port. */
  readonly port: number;
  /**
   * The environment VM's published DNS alias (`vm_host_for_env`, e.g. `cogni.vm.cognidao.org`). Absent
   * omits the whole substrate block, exactly like the composition's absent `runtime.substrateHost`.
   */
  readonly substrateHost?: string | undefined;
  /**
   * How THIS attempt reaches the shared services (the sequencer decides per attempt, hard requirement 18).
   * Absent = `egress` (today's env, byte for byte). `mesh` binds them through the `cogni-substrate`
   * companion and needs no `substrateHost`.
   */
  readonly transport?: SubstrateTransport | undefined;
  readonly databasePoolLimits?: NodeAppPoolLimits | undefined;
  readonly lokiPush?: NodeAppLokiPush | undefined;
  /**
   * The release's declared secret KEY names (`NodeWorkloadSpec.secretKeys`); absent = the profile keys
   * only. Only these keys are ever injected.
   */
  readonly secretKeys?: readonly string[] | undefined;
  /** The values read for those keys. Filtered to the declared set here; never trusted. */
  readonly secrets: Readonly<Record<string, string>>;
  /** Env names a declared state binding supplies (CD2); not required from the bucket. */
  readonly boundEnvNames?: readonly string[] | undefined;
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const BIND_HOST = "0.0.0.0";
const LITELLM_VIRTUAL_KEY = "LITELLM_VIRTUAL_KEY";
const LITELLM_MASTER_KEY = "LITELLM_MASTER_KEY";

/**
 * The node's isolated migration DSN (`migration_<node>`), read from its own OpenBao bucket
 * `<env>/<slug>-database-migration` (task.5408). The start wrapper uses it to migrate before the app
 * starts, then unsets it (`database-ca-command.ts` GREEN_MIGRATES_ITSELF).
 */
export const NODE_APP_MIGRATION_KEY = "DATABASE_MIGRATION_URL";

/**
 * The secret keys an app must receive: the declared set (profile keys when none is declared), plus the
 * migration DSN, minus those a declared state binding supplies. A node app whose DATABASE_URL is bound to
 * a state workload gets no migration DSN (the bucket's DSN names another database). Contract order,
 * deduped.
 */
export function nodeAppSecretKeys(
  declared: readonly string[] | undefined,
  boundEnvNames: readonly string[] = []
): readonly string[] {
  const bound = new Set(boundEnvNames);
  const keys = declared
    ? declared
    : resolveRuntimeProfileSecretRefs({
        runtimeProfile: "cogni-node-app-v1",
        secretRefs: [],
      }).map((r) => r.key);
  const migration = bound.has("DATABASE_URL") ? [] : [NODE_APP_MIGRATION_KEY];
  return [...new Set([...keys, ...migration])].filter((k) => !bound.has(k));
}

/** The injectable part of the declared keys: valid env names that are not operator/fleet credentials. */
export function injectableSecrets(
  keys: readonly string[],
  values: Readonly<Record<string, string>>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = values[key];
    if (typeof value !== "string" || value.length === 0) continue;
    if (!ENV_NAME.test(key) || !isOffClusterWorkloadSecretKey(key)) continue;
    out[key] = value;
  }
  return out;
}

// Field definitions own both emitted values and the admission namespace. Optional runtime
// blocks still own their destinations when a different environment does not supply the block.
type RuntimeIdentity = Pick<WorkerEnvInput, "env" | "sourceSha" | "port">;
const COMMON_FIELDS = {
  HOST: () => BIND_HOST,
  PORT: (i: RuntimeIdentity) => String(i.port),
  DEPLOY_ENVIRONMENT: (i: RuntimeIdentity) => i.env,
  COGNI_REPO_SHA: (i: RuntimeIdentity) => i.sourceSha,
};
const APP_BASE_FIELDS = {
  HOSTNAME: () => BIND_HOST,
  APP_ENV: () => "production",
};
type SubstrateFieldInput = { host: string; env: string };
const SUBSTRATE_FIELDS = {
  TEMPORAL_ADDRESS: (i: SubstrateFieldInput) =>
    `${i.host}:${SUBSTRATE_PORTS.temporal}`,
  TEMPORAL_NAMESPACE: (i: SubstrateFieldInput) => `cogni-${i.env}`,
  TEMPORAL_TASK_QUEUE: () => "scheduler-tasks",
  REDIS_URL: (i: SubstrateFieldInput) =>
    `redis://${i.host}:${SUBSTRATE_PORTS.redis}`,
  LITELLM_BASE_URL: (i: SubstrateFieldInput) =>
    `http://${i.host}:${SUBSTRATE_PORTS["ai-gateway"]}`,
};
/** Egress only: not a registry row, so a mesh attempt never receives it (hard requirement 3). */
const EGRESS_ONLY_SUBSTRATE_FIELDS = {
  SCHEDULER_WORKER_HEALTH_URL: (i: SubstrateFieldInput) =>
    `http://${i.host}:${EGRESS_ONLY_PORTS["scheduler-worker-health"]}`,
};
const DOLTGRES_URL = "DOLTGRES_URL";
const POOL_FIELDS = {
  DB_POOL_MAX: (i: NodeAppPoolLimits) => String(i.app),
  DB_SERVICE_POOL_MAX: (i: NodeAppPoolLimits) => String(i.service),
  DB_READ_POOL_MAX: (i: NodeAppPoolLimits) => String(i.read),
};
const LOKI_FIELDS = {
  LOKI_PUSH_URL: (i: NodeAppLokiPush) => i.url,
  LOKI_PUSH_USER: (i: NodeAppLokiPush) => i.user,
  LOKI_PUSH_PASSWORD: (i: NodeAppLokiPush) => i.password,
  LOKI_PUSH_SOURCE: () => "lease",
};
const APP_IDENTITY_FIELDS = {
  DOMAIN: (i: NodeAppEnvInput) => i.operatorDomain,
  COGNI_NODE_ID: (i: NodeAppEnvInput) => i.nodeId,
  NODE_NAME: (i: NodeAppEnvInput) => i.slug,
  COGNI_REPO_PATH: () => "/app",
  AUTH_TRUST_HOST: () => "true",
  NEXTAUTH_URL: (i: NodeAppEnvInput) => `https://${i.publicHost}`,
  APP_BASE_URL: (i: NodeAppEnvInput) => `https://${i.publicHost}`,
};
const RELEASE_FIELDS = { RELEASE_SHA: (sourceSha: string) => sourceSha };

function fieldValues<T>(
  fields: Readonly<Record<string, (input: T) => string>>,
  input: T
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, value(input)])
  );
}

const appSecretDestination = (key: string): string =>
  key === LITELLM_VIRTUAL_KEY ? LITELLM_MASTER_KEY : key;

/** Sequencer-owned release identity has the same owner as the rest of the runtime namespace. */
export function releaseIdentityEnv(sourceSha: string): Record<string, string> {
  return fieldValues(RELEASE_FIELDS, sourceSha);
}

/** Reject only keys the consumer's runtime can overwrite; keep ordinary declared-env precedence. */
export function runtimeOwnedEnvKeys(
  profile: "app" | "worker",
  secretKeys: readonly string[]
): ReadonlySet<string> {
  const fields =
    profile === "app"
      ? [
          COMMON_FIELDS,
          APP_BASE_FIELDS,
          SUBSTRATE_FIELDS,
          EGRESS_ONLY_SUBSTRATE_FIELDS,
          POOL_FIELDS,
          LOKI_FIELDS,
          APP_IDENTITY_FIELDS,
          RELEASE_FIELDS,
        ]
      : [COMMON_FIELDS];
  return new Set([
    ...fields.flatMap(Object.keys),
    ...(profile === "app"
      ? nodeAppSecretKeys(secretKeys).map(appSecretDestination)
      : secretKeys),
  ]);
}

/** The shared services the node app's substrate block names (Temporal, Redis, the AI gateway). */
const NODE_APP_SUBSTRATE_TYPES: readonly SubstrateType[] = [
  "temporal",
  "redis",
  "ai-gateway",
];

export interface NodeAppSubstrateBindingInput {
  readonly transport?: SubstrateTransport | undefined;
  /** The env VM alias (`NODE_DEPLOY_SUBSTRATE_HOST[S]`). Used by `egress` only. */
  readonly substrateHost?: string | undefined;
  readonly secretKeys?: readonly string[] | undefined;
  readonly boundEnvNames?: readonly string[] | undefined;
}

/**
 * THE substrate binding of one node app attempt (task.5432, CD2). The sequencer passes the SAME input it
 * gives `nodeAppEnv`; `ports` is the attempt's mesh grant (`NodeSubstrateGrant.ports`) and the
 * `cogni-substrate` listener set, and `nodeAppEnv` derives its substrate env from this same output.
 * Doltgres is included when `DOLTGRES_URL` comes from the bucket (not from a state binding). Postgres is
 * not included: its endpoint is placement-owned.
 */
export function nodeAppSubstrateBinding(
  input: NodeAppSubstrateBindingInput
): SubstrateBinding | undefined {
  const keys = nodeAppSecretKeys(input.secretKeys, input.boundEnvNames);
  return resolveSubstrateBinding({
    transport: input.transport ?? "egress",
    vmHost: input.substrateHost,
    types: [
      ...NODE_APP_SUBSTRATE_TYPES,
      ...(keys.includes(DOLTGRES_URL) ? (["doltgres"] as const) : []),
    ],
  });
}

export function nodeAppEnv(input: NodeAppEnvInput): Record<string, string> {
  const keys = nodeAppSecretKeys(input.secretKeys, input.boundEnvNames);
  const refused = keys.filter((k) => !isOffClusterWorkloadSecretKey(k));
  if (refused.length > 0)
    throw new Error(
      `node app env refused: operator/fleet credentials may not be injected: ${refused.join(", ")}`
    );
  const injectable = injectableSecrets(keys, input.secrets);
  const missing = keys.filter((k) => injectable[k] === undefined);
  if (missing.length > 0)
    throw new Error(
      `node app env refused: required secret keys missing or not injectable: ${missing.join(", ")}`
    );
  if (input.databasePoolLimits && input.databasePoolLimits.replicaCount !== 1)
    throw new Error("database pools require exactly one app replica");

  const e = {
    ...fieldValues(COMMON_FIELDS, input),
    ...fieldValues(APP_BASE_FIELDS, input),
  };
  const binding = nodeAppSubstrateBinding(input);
  if (binding) {
    const at = { host: binding.host, env: input.env };
    Object.assign(e, fieldValues(SUBSTRATE_FIELDS, at));
    if (binding.transport === "egress")
      Object.assign(e, fieldValues(EGRESS_ONLY_SUBSTRATE_FIELDS, at));
  }
  for (const [key, value] of Object.entries(injectable))
    e[appSecretDestination(key)] = value;
  // MESH_ENV: the bucket keeps the Doltgres credential; the binding owns its endpoint.
  const doltgres = injectable[DOLTGRES_URL];
  if (binding?.transport === "mesh" && doltgres !== undefined) {
    if (!binding.types.includes("doltgres"))
      throw new Error("node app env refused: Doltgres has no mesh binding");
    e[DOLTGRES_URL] = rebindDsnEndpoint(
      doltgres,
      binding.host,
      SUBSTRATE_PORTS.doltgres
    );
  }
  // Platform identity and optional catalog/push outputs retain precedence over secrets.
  if (input.databasePoolLimits)
    Object.assign(e, fieldValues(POOL_FIELDS, input.databasePoolLimits));
  if (input.lokiPush)
    Object.assign(e, fieldValues(LOKI_FIELDS, input.lokiPush));
  // The operator issuer (sign-in origin binding, #3029) is platform identity: it wins over every key above.
  if (!input.operatorDomain)
    throw new Error("operator issuer domain is required");
  Object.assign(e, fieldValues(APP_IDENTITY_FIELDS, input));
  return e;
}

export interface WorkerEnvInput {
  /** Deployment environment (`candidate-a` | `preview` | `production`). */
  readonly env: string;
  /** The release's source sha (`COGNI_REPO_SHA`, what `/version` must serve). */
  readonly sourceSha: string;
  /** The container port. */
  readonly port: number;
  /** The worker's own declared secret KEY names (`NodeWorkloadSpec.secretKeys`). */
  readonly secretKeys: readonly string[];
  /** The values read for those keys. Filtered to the declared set here; never trusted. */
  readonly secrets: Readonly<Record<string, string>>;
}

/**
 * The runtime env of a node WORKER workload (task.5272): a sibling service of the node app, such as a
 * code-execution sandbox. WORKER_GETS_ITS_OWN_SECRETS_ONLY: exactly the keys its own repo-spec service
 * declares, never the `cogni-node-app-v1` profile, so no database, auth, LLM or substrate credential and
 * no substrate topology ever reaches it. Fails closed on a missing or denylisted key, like `nodeAppEnv`.
 */
export function workerEnv(input: WorkerEnvInput): Record<string, string> {
  const keys = [...new Set(input.secretKeys)];
  const refused = keys.filter((k) => !isOffClusterWorkloadSecretKey(k));
  if (refused.length > 0)
    throw new Error(
      `worker env refused: operator/fleet credentials may not be injected: ${refused.join(", ")}`
    );
  const injectable = injectableSecrets(keys, input.secrets);
  const missing = keys.filter((k) => injectable[k] === undefined);
  if (missing.length > 0)
    throw new Error(
      `worker env refused: required secret keys missing or not injectable: ${missing.join(", ")}`
    );
  return {
    ...fieldValues(COMMON_FIELDS, input),
    ...injectable,
  };
}
