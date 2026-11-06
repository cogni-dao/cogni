// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/env-lanes`
 * Purpose: One sequencer process serves EVERY env its cluster controls (story.5137 ONE FRONT DOOR): the
 *   fleet control env reconciles every Akash lane, so the production sequencer also deploys the candidate-a
 *   and preview lanes of canonical nodes. This module is the pure part of that composition: which envs, each
 *   env's secrets namespace and substrate host, and the runner that gives every env its own pass and its own
 *   failure domain.
 * Scope: Config resolution (no I/O) and a thin runner over per-env `NodeDeploySequencer`s. Every deploy
 *   decision stays in `./sequencer`; the composition root (`bootstrap/node-deploy-sequencer.ts`) builds one
 *   sequencer per `EnvLane` over the SHARED payer, store, DNS credentials and advisory lock.
 * Invariants:
 *   - ONE_PROCESS_ONE_LOCK: all envs share the one pod, the one DB connection and the one leader lock; there
 *     is one `EnvLane` per env, never one process per env.
 *   - SECRETS_NAMESPACE_IS_THE_ENV (CD2): an env's namespace is exactly `cogni-node-deploy-<env>`. The
 *     admission policy derives `<env>` from that name, so a lane can read only `<env>/<slug>`. A configured
 *     `NODE_DEPLOY_SECRETS_NAMESPACE` that disagrees is refused at boot, never trusted.
 *   - NO_HALF_ENV: an env with no substrate host is refused at boot (a node app would run with a half env).
 *   - DEFAULT_IS_ONE_ENV: with no `NODE_DEPLOY_ENVS` the process serves exactly its DEPLOY_ENVIRONMENT
 *     with today's `NODE_DEPLOY_SECRETS_NAMESPACE` / `NODE_DEPLOY_SUBSTRATE_HOST`, byte for byte.
 *   - PER_ENV_FAULT_DOMAIN: a pass that throws in one env never stalls another env's pass.
 *   - TRANSPORT_IS_A_LANE_PROPERTY (task.5431, hub node-service-delivery section 6):
 *     `NODE_DEPLOY_SUBSTRATE_TRANSPORTS` (`env=mesh|egress,...`) sets each lane's substrate transport; an
 *     unlisted env is `egress`. A `mesh` lane needs a valid operator domain root, because its control URL
 *     is `https://mesh-<env>.<root>` (the env Headscale's `server_url`). Never a per-node setting.
 * Side-effects: none (the runner calls the sequencers it is handed)
 * Links: bootstrap/node-deploy-sequencer.ts, infra/k8s/base/node-deploy-sequencer/admission-policy.yaml,
 *   hub `node-service-delivery`
 * @public
 */

import type { SubstrateTransport } from "@/ports";
import { hostForEnv, isFlightEnv } from "@/shared/node-registry/deploy-hosts";

/** The envs a node-deploy lane can exist in. */
const NODE_DEPLOY_ENVS = ["candidate-a", "preview", "production"] as const;
type NodeDeployEnv = (typeof NODE_DEPLOY_ENVS)[number];

/** `cogni-node-deploy-<env>`: the dedicated secrets namespace of one env's lane. */
const NODE_DEPLOY_SECRETS_NAMESPACE_PREFIX = "cogni-node-deploy-";

export function secretsNamespaceFor(env: string): string {
  return `${NODE_DEPLOY_SECRETS_NAMESPACE_PREFIX}${env}`;
}

export interface EnvLane {
  readonly environment: string;
  /** `cogni-node-deploy-<env>`: where this env's state passwords and `nd-<slug>-env` ExternalSecrets live. */
  readonly secretsNamespace: string;
  /** `vm_host_for_env` of this env's VM: where its shared substrate answers. */
  readonly substrateHost: string;
  readonly operatorDomain: string;
  /** How this lane's node apps reach the substrate (`NODE_DEPLOY_SUBSTRATE_TRANSPORTS`). */
  readonly substrateTransport: SubstrateTransport;
  /** `https://mesh-<env>.<root>`; set only for a `mesh` lane. */
  readonly meshControlUrl?: string | undefined;
}

export class EnvLaneConfigError extends Error {
  constructor(
    readonly code:
      | "operator_domain_invalid"
      | "environment_invalid"
      | "environment_duplicate"
      | "secrets_namespace_invalid"
      | "substrate_host_missing"
      | "substrate_hosts_invalid"
      | "substrate_transports_invalid",
    message: string
  ) {
    super(message);
    this.name = "EnvLaneConfigError";
  }
}

export interface EnvLaneInput {
  /** The pod's own `DEPLOY_ENVIRONMENT`. */
  readonly deployEnvironment: string;
  readonly operatorDomainRoot: string | undefined;
  /** The pod's own (wallet) namespace; no lane may use it for secrets. */
  readonly podNamespace: string;
  /** `NODE_DEPLOY_ENVS`: comma-separated envs; unset serves only `deployEnvironment`. */
  readonly environments?: string | undefined;
  /** `NODE_DEPLOY_SECRETS_NAMESPACE`: must equal this pod's own env's `cogni-node-deploy-<env>`. */
  readonly secretsNamespace?: string | undefined;
  /** `NODE_DEPLOY_SUBSTRATE_HOST`: the substrate host of `deployEnvironment` (single-env form). */
  readonly substrateHost?: string | undefined;
  /** `NODE_DEPLOY_SUBSTRATE_HOSTS`: `env=host,env=host`; wins over the single-host var per env. */
  readonly substrateHosts?: string | undefined;
  /** `NODE_DEPLOY_SUBSTRATE_TRANSPORTS`: `env=mesh|egress,...`; unlisted envs are `egress`. */
  readonly substrateTransports?: string | undefined;
}

function isEnv(value: string): value is NodeDeployEnv {
  return (NODE_DEPLOY_ENVS as readonly string[]).includes(value);
}

/** Parse `env=host,env=host` (whitespace-tolerant). */
export function parseSubstrateHosts(
  raw: string | undefined
): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (raw ?? "").split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    const env = eq > 0 ? entry.slice(0, eq).trim() : "";
    const host = eq > 0 ? entry.slice(eq + 1).trim() : "";
    if (!isEnv(env) || !host || out.has(env))
      throw new EnvLaneConfigError(
        "substrate_hosts_invalid",
        `NODE_DEPLOY_SUBSTRATE_HOSTS entry "${entry}" must be <env>=<host> with env in ${NODE_DEPLOY_ENVS.join("|")}, once each`
      );
    out.set(env, host);
  }
  return out;
}

/** Parse `env=mesh|egress,...` (whitespace-tolerant); each env at most once. */
export function parseSubstrateTransports(
  raw: string | undefined
): Map<string, SubstrateTransport> {
  const out = new Map<string, SubstrateTransport>();
  for (const part of (raw ?? "").split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    const env = eq > 0 ? entry.slice(0, eq).trim() : "";
    const transport = eq > 0 ? entry.slice(eq + 1).trim() : "";
    if (
      !isEnv(env) ||
      (transport !== "mesh" && transport !== "egress") ||
      out.has(env)
    )
      throw new EnvLaneConfigError(
        "substrate_transports_invalid",
        `NODE_DEPLOY_SUBSTRATE_TRANSPORTS entry "${entry}" must be <env>=mesh|egress with env in ${NODE_DEPLOY_ENVS.join("|")}, once each`
      );
    out.set(env, transport);
  }
  return out;
}

/** Resolve the per-env lanes the one process serves, or throw `EnvLaneConfigError` (boot refuses). */
export function resolveEnvLanes(input: EnvLaneInput): EnvLane[] {
  const root = input.operatorDomainRoot;
  // Keep lanes observable when issuer config is invalid; nodeAppEnv refuses a fresh create.
  const validRoot =
    !!root &&
    root.length <= 245 &&
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      root
    );
  const issuerFor = (env: string): string => {
    if (!isFlightEnv(env))
      throw new EnvLaneConfigError(
        "environment_invalid",
        `unsupported environment "${env}"`
      );
    return validRoot && root ? hostForEnv("operator", true, env, root) : "";
  };
  const listed = (input.environments ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  const hosts = parseSubstrateHosts(input.substrateHosts);
  const transports = parseSubstrateTransports(input.substrateTransports);
  const transportFor = (
    env: string
  ): Pick<EnvLane, "substrateTransport" | "meshControlUrl"> => {
    if (transports.get(env) !== "mesh") return { substrateTransport: "egress" };
    if (!validRoot || !root)
      throw new EnvLaneConfigError(
        "substrate_transports_invalid",
        `${env}=mesh needs a valid NODE_DEPLOY_OPERATOR_DOMAIN_ROOT (control URL https://mesh-${env}.<root>)`
      );
    return {
      substrateTransport: "mesh",
      meshControlUrl: `https://mesh-${env}.${root}`,
    };
  };
  const hostFor = (env: string, own: boolean): string => {
    const host = hosts.get(env) ?? (own ? input.substrateHost : undefined);
    if (!host)
      throw new EnvLaneConfigError(
        "substrate_host_missing",
        `no substrate host for ${env} (NODE_DEPLOY_SUBSTRATE_HOST / NODE_DEPLOY_SUBSTRATE_HOSTS); a node app would run with a half env`
      );
    return host;
  };

  // DEFAULT_IS_ONE_ENV: no list = today's single-env process, its namespace taken as configured.
  if (listed.length === 0) {
    const ns = input.secretsNamespace;
    if (!ns || ns === input.podNamespace)
      throw new EnvLaneConfigError(
        "secrets_namespace_invalid",
        "NODE_DEPLOY_SECRETS_NAMESPACE is required and must NOT be the pod's own (wallet) namespace"
      );
    return [
      {
        environment: input.deployEnvironment,
        secretsNamespace: ns,
        substrateHost: hostFor(input.deployEnvironment, true),
        operatorDomain: issuerFor(input.deployEnvironment),
        ...transportFor(input.deployEnvironment),
      },
    ];
  }

  const lanes: EnvLane[] = [];
  for (const env of listed) {
    if (!isEnv(env))
      throw new EnvLaneConfigError(
        "environment_invalid",
        `environment "${env}" is not one of ${NODE_DEPLOY_ENVS.join("|")}`
      );
    if (lanes.some((l) => l.environment === env))
      throw new EnvLaneConfigError(
        "environment_duplicate",
        `environment "${env}" is listed twice`
      );
    const secretsNamespace = secretsNamespaceFor(env);
    if (secretsNamespace === input.podNamespace)
      throw new EnvLaneConfigError(
        "secrets_namespace_invalid",
        "a secrets namespace must NOT be the pod's own (wallet) namespace"
      );
    const own = env === input.deployEnvironment;
    if (own && input.secretsNamespace !== secretsNamespace)
      throw new EnvLaneConfigError(
        "secrets_namespace_invalid",
        `NODE_DEPLOY_SECRETS_NAMESPACE must be ${secretsNamespace} for ${env} (the admission policy derives the env from the namespace name)`
      );
    lanes.push({
      environment: env,
      secretsNamespace,
      substrateHost: hostFor(env, own),
      operatorDomain: issuerFor(env),
      ...transportFor(env),
    });
  }
  return lanes;
}

/** The two loops a lane's sequencer exposes. */
export interface LaneSequencer {
  tick(): Promise<void>;
  reconcileAll(): Promise<void>;
}

/**
 * Runs `tick` / `reconcileAll` for every env lane. Each env is its OWN failure domain (PER_ENV_FAULT_DOMAIN):
 * a throw in one is handed to `onError` and the others still run in the same pass.
 */
export class EnvLaneSequencers {
  constructor(
    private readonly lanes: readonly {
      readonly environment: string;
      readonly sequencer: LaneSequencer;
    }[],
    private readonly onError: (
      environment: string,
      loop: "tick" | "reconcile",
      error: unknown
    ) => void
  ) {}

  get environments(): string[] {
    return this.lanes.map((l) => l.environment);
  }

  async tick(): Promise<void> {
    await Promise.all(
      this.lanes.map((l) =>
        l.sequencer
          .tick()
          .catch((error: unknown) => this.onError(l.environment, "tick", error))
      )
    );
  }

  async reconcileAll(): Promise<void> {
    await Promise.all(
      this.lanes.map((l) =>
        l.sequencer
          .reconcileAll()
          .catch((error: unknown) =>
            this.onError(l.environment, "reconcile", error)
          )
      )
    );
  }
}
