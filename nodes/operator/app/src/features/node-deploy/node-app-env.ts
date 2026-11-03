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
 *   - EVERY_BUCKET_KEY_EXCEPT_THE_DENYLIST: a node's own `secret_refs` live in the NODE repo's
 *     repo-spec, which the sequencer never reads. So every key of the node's own bucket enters the env,
 *     EXCEPT `OFF_CLUSTER_WORKLOAD_DENIED_KEYS` (operator/fleet/substrate credentials that must never
 *     reach rented compute) and names that are not valid env names. A denied key is dropped, never
 *     injected, even if it is present in the bucket.
 *   - PROFILE_KEYS_FAIL_CLOSED: every `COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS` key must be present and
 *     non-empty, else this throws and the caller deploys NOTHING (never a half env). A key the node
 *     binds to a state workload (CD2: the declared binding overrides) is not required from the bucket.
 *   - LITELLM_KEY_RENAME: the node-scoped `LITELLM_VIRTUAL_KEY` is delivered as `LITELLM_MASTER_KEY`
 *     and is NOT also passed under its own name (byte-identical to the composition). The fleet master
 *     key is on the denylist and can never arrive through the bucket.
 *   - NO_NODE_NAMES: nothing here names a node.
 * Side-effects: none
 * Links: infra/crossplane/xcomputeworkload/composition.yaml, packages/repo-spec/src/node-app-deployment.ts,
 *   shared/secrets/node-secrets-reserved.data.ts, task.5405
 * @internal
 */

import { COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS } from "@cogni/repo-spec";

import { isOffClusterWorkloadSecretKey } from "@/shared/secrets/node-secrets-reserved.data";

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
  /** The container port. */
  readonly port: number;
  /**
   * The environment VM's published DNS alias (`vm_host_for_env`, e.g. `cogni.vm.cognidao.org`). Absent
   * omits the whole substrate block, exactly like the composition's absent `runtime.substrateHost`.
   */
  readonly substrateHost?: string | undefined;
  readonly databasePoolLimits?: NodeAppPoolLimits | undefined;
  readonly lokiPush?: NodeAppLokiPush | undefined;
  /** The node's whole bucket, as read from OpenBao. Filtered here; never trusted. */
  readonly secrets: Readonly<Record<string, string>>;
  /** Env names a declared state binding supplies (CD2); not required from the bucket. */
  readonly boundEnvNames?: readonly string[] | undefined;
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const BIND_HOST = "0.0.0.0";
const LITELLM_VIRTUAL_KEY = "LITELLM_VIRTUAL_KEY";
const LITELLM_MASTER_KEY = "LITELLM_MASTER_KEY";

/** The bucket keys the `cogni-node-app-v1` profile owes, minus those a state binding supplies. */
export function nodeAppRequiredSecretKeys(
  boundEnvNames: readonly string[] = []
): readonly string[] {
  const bound = new Set(boundEnvNames);
  return COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS.filter((k) => !bound.has(k));
}

/** The injectable part of a bucket: valid env names that are not operator/fleet/substrate credentials. */
export function injectableSecrets(
  bucket: Readonly<Record<string, string>>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(bucket)) {
    if (typeof value !== "string" || value.length === 0) continue;
    if (!ENV_NAME.test(key) || !isOffClusterWorkloadSecretKey(key)) continue;
    out[key] = value;
  }
  return out;
}

export function nodeAppEnv(input: NodeAppEnvInput): Record<string, string> {
  const injectable = injectableSecrets(input.secrets);
  const missing = nodeAppRequiredSecretKeys(input.boundEnvNames).filter(
    (k) => injectable[k] === undefined
  );
  if (missing.length > 0)
    throw new Error(
      `node app env refused: required secret keys missing or not injectable: ${missing.join(", ")}`
    );
  if (input.databasePoolLimits && input.databasePoolLimits.replicaCount !== 1)
    throw new Error("database pools require exactly one app replica");

  const e: Record<string, string> = {};
  e.HOST = BIND_HOST;
  e.HOSTNAME = BIND_HOST;
  e.PORT = String(input.port);
  e.APP_ENV = "production";
  e.DEPLOY_ENVIRONMENT = input.env;
  e.COGNI_REPO_SHA = input.sourceSha;
  const substrate = input.substrateHost;
  if (substrate) {
    e.TEMPORAL_ADDRESS = `${substrate}:7233`;
    e.TEMPORAL_NAMESPACE = `cogni-${input.env}`;
    e.TEMPORAL_TASK_QUEUE = "scheduler-tasks";
    e.REDIS_URL = `redis://${substrate}:6379`;
    e.LITELLM_BASE_URL = `http://${substrate}:4000`;
    e.SCHEDULER_WORKER_HEALTH_URL = `http://${substrate}:30900`;
  }
  for (const [key, value] of Object.entries(injectable)) {
    if (key === LITELLM_VIRTUAL_KEY) e[LITELLM_MASTER_KEY] = value;
    else e[key] = value;
  }
  e.COGNI_NODE_ID = input.nodeId;
  if (input.databasePoolLimits) {
    e.DB_POOL_MAX = String(input.databasePoolLimits.app);
    e.DB_SERVICE_POOL_MAX = String(input.databasePoolLimits.service);
    e.DB_READ_POOL_MAX = String(input.databasePoolLimits.read);
  }
  if (input.lokiPush) {
    e.LOKI_PUSH_URL = input.lokiPush.url;
    e.LOKI_PUSH_USER = input.lokiPush.user;
    e.LOKI_PUSH_PASSWORD = input.lokiPush.password;
    e.LOKI_PUSH_SOURCE = "lease";
  }
  // buildNodeAppIdentityEnv(): deliberately wins over every key above.
  e.NODE_NAME = input.slug;
  e.COGNI_REPO_PATH = "/app";
  e.AUTH_TRUST_HOST = "true";
  e.NEXTAUTH_URL = `https://${input.publicHost}`;
  e.APP_BASE_URL = `https://${input.publicHost}`;
  return e;
}
