// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/node-deploy-sequencer`
 * Purpose: Composition root for the node-deploy sequencer (task.5400, story.5127) — the dedicated
 *   process that converges every desired workload to its release by immutable blue/green. It binds the
 *   REAL `NodeDeploySequencer` over: the private actuator (the ONLY paid Akash writer), operator
 *   Postgres, Cloudflare DNS, a Kubernetes Secret for generated state passwords, and public probes.
 * Scope: Wiring, minimal env validation, the single-instance advisory lock, loop scheduling and
 *   lifecycle. Every deploy decision lives in `@features/node-deploy/sequencer`.
 * Invariants:
 *   - PAYS_ONLY_THROUGH_THE_ACTUATOR: this process holds the actuator BEARER, never a Console key or a
 *     wallet. `ActuatorPayer` is the only payer wired here; ConsolePayer is dev-only.
 *   - SECRETS_ARRIVE_AS_FILES: credentials are read from a projected Secret volume, never process env.
 *   - SINGLE_INSTANCE: a Postgres session advisory lock is held on the one pooled connection for the
 *     life of the process. A second replica idles (not ready) and a lost lock connection exits the process;
 *     two sequencers can therefore never drive one workload.
 *   - NO_SECRETS_IN_THE_WALLET_NAMESPACE: generated state passwords live in a DEDICATED namespace
 *     (`NODE_DEPLOY_SECRETS_NAMESPACE`, `cogni-node-deploy-<env>`), never in the actuator's namespace;
 *     boot is refused if the two are the same.
 *   - ONE_DB_CONNECTION: the pool is max 1 and the session advisory lock rides on that SAME connection
 *     (operator-control-v1 budgets exactly one). A heartbeat keeps the connection from idling out and
 *     proves THIS backend still holds the lock; losing it exits the process.
 *   - NO_EDGE_NO_HTTP_APPS: without Cloudflare credentials the process still runs (state workloads work)
 *     and the sequencer refuses http apps BEFORE paying.
 *   - FAIL_LOUD_FOR_ITSELF: a missing actuator token or database URL refuses boot (CrashLoopBackOff).
 *   - ONE_PROCESS_EVERY_ENV (story.5137): `NODE_DEPLOY_ENVS` (default: only `DEPLOY_ENVIRONMENT`) lists
 *     the envs this cluster controls; the process builds one `NodeDeploySequencer` per env over the SHARED
 *     payer, store, Cloudflare credentials, leader lock and pod. Per env: secrets namespace
 *     `cogni-node-deploy-<env>`, substrate host (`NODE_DEPLOY_SUBSTRATE_HOSTS`), edge hosts from that env's
 *     catalog `node-deploy` cells. The payer env is the release's env. One pass per env, each its own
 *     failure domain (`EnvLaneSequencers`). Resolution is pure and tested in `features/node-deploy/env-lanes`.
 *   - NODE_APP_ENV_NEEDS_ITS_INPUTS (task.5405): every served env needs a substrate host
 *     (`NODE_DEPLOY_SUBSTRATE_HOST` for the single env, `NODE_DEPLOY_SUBSTRATE_HOSTS` per env), because a node app
 *     deployed without it would run with a half env. Node secrets arrive through the existing custody path
 *     (OpenBao -> ESO -> a Secret in the env's `cogni-node-deploy-<env>` namespace); this process holds NO
 *     OpenBao identity and needs no new OpenBao role.
 *   - FLEET_FILTER (story.5137 CD4): `NODE_DEPLOY_FLEET_OWNER` is the org that owns this fleet's node repos. Each
 *     env's edge guard admits only catalog nodes that org owns (the route applies the same predicate), and an
 *     unset owner admits no remote-source node, so the test operator never deploys canonical nodes.
 *   - IMAGE_PINNED_BEFORE_PAY (story.5137): every lane resolves a pending release image through the anonymous
 *     ghcr resolver and pins the digest write-once before any paid create.
 *   - ONE_EDGE_ZONE (story.5137): `NODE_DEPLOY_FLEET_OWNER` + `NODE_DEPLOY_WORKLOAD_ZONE` resolve ONE fleet binding
 *     (`resolveWorkloadZoneBinding`) in `composeNodeDeployLanes`, the one lane composition. The zone id is looked up
 *     BY NAME with the zone-scoped token (`resolveCloudflareZoneId`), so it can never name a zone the token cannot
 *     read, and the DNS adapter re-verifies that native id/name before every use. An invalid binding or a failed
 *     lookup leaves the edge unconfigured: recovery continues, fresh http apps wait before paying. Operator and
 *     substrate hosts are not node hosts and stay where they are.
 *   - INTERIM_APP_PROVIDERS (task.5405): `NODE_DEPLOY_APP_PROVIDERS` (comma-separated akash accounts, max 16)
 *     is sent as `allowProviders` on every APP create; unset sends none.
 *   - MESH_LANES_ONLY (task.5431): a lane whose `NODE_DEPLOY_SUBSTRATE_TRANSPORTS` value is `mesh` gets its
 *     env tailnet: a `HeadscaleSocketAdapter` over `/var/run/headscale/<env>/headscale.sock` (the pod-local socket
 *     task.5428 shares with this container only; no API key exists), one `MeshPlane`, the attempt-key
 *     Secrets in the lane's `cogni-node-deploy-<env>` namespace, and the env VM's published `substrate-gw`
 *     request read over verified HTTPS. Its mesh pass runs inside the reconcile loop, under the leader lock.
 *     An egress lane builds none of it.
 * Side-effects: IO (Postgres, actuator HTTP, Cloudflare, Kubernetes API, provider ingress; health listener)
 * Links: @features/node-deploy/sequencer, infra/k8s/base/node-deploy-sequencer, task.5400
 * @internal
 */

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

import { createAppDbClient } from "@cogni/db-client";
import pino from "pino";

import {
  ActuatorPayer,
  AdvisoryLeader,
  AkashChainTruth,
  CloudflareDnsRecords,
  EsoNodeRuntimeSecrets,
  GhcrBuiltImageResolver,
  HttpProbe,
  HttpsSubstrateRequestSource,
  ImageCatalogNodes,
  KubernetesMeshKeys,
  KubernetesStatePasswords,
  PostgresNodeDeployStore,
  resolveCloudflareZoneId,
} from "@/adapters/server";
// By path, not the barrel: the Headscale gRPC client stays out of `@/adapters/server`, which the Next app imports.
import { HeadscaleSocketAdapter } from "@/adapters/server/node-deploy/headscale.adapter";
import {
  type EnvLane,
  EnvLaneConfigError,
  EnvLaneSequencers,
  resolveEnvLanes,
} from "@/features/node-deploy/env-lanes";
import { MeshPlane } from "@/features/node-deploy/mesh-plane";
import { DEFAULT_SEQUENCER_CONFIG } from "@/features/node-deploy/sequencer";
import type { WorkloadZoneBinding } from "@/shared/node-registry/fleet-ownership";
import { composeNodeDeployLanes } from "./node-deploy-lanes";

const LISTEN_PORT = 8080;
const CREDENTIAL_DIR = "/var/run/secrets/node-deploy-sequencer";
const TICK_MS = 5_000;
const RECONCILE_MS = 60_000;
/**
 * task.5428: each tailnet Headscale's unix socket, `/var/run/headscale/<tailnet>/headscale.sock`, on a
 * pod-local volume shared by that Headscale container and this one only (`unix_socket` in its config).
 */
const headscaleSocketFor = (tailnet: string): string =>
  `/var/run/headscale/${tailnet}/headscale.sock`;

// biome-ignore lint/style/noProcessEnv: dedicated process composition root validates its own minimal env
const runtimeEnv = process.env;
const log = pino({ level: runtimeEnv.LOG_LEVEL ?? "info" }).child({
  component: "node-deploy-sequencer",
});

const namespace = runtimeEnv.POD_NAMESPACE;
const environment = runtimeEnv.DEPLOY_ENVIRONMENT;
if (!namespace || !environment) {
  throw new Error("POD_NAMESPACE and DEPLOY_ENVIRONMENT are required");
}

const readCredential = (name: string): Promise<string> =>
  readFile(`${CREDENTIAL_DIR}/${name}`, "utf8")
    .then((value) => value.trim())
    .catch(() => "");

const [actuatorToken, databaseUrl, cfToken, cfZone] = await Promise.all([
  readCredential("AKASH_TX_ACTUATOR_TOKEN"),
  readCredential("DATABASE_URL"),
  readCredential("CLOUDFLARE_API_TOKEN"),
  readCredential("CLOUDFLARE_ZONE_ID"),
]);

if (!actuatorToken) {
  log.fatal(
    { reason: "ActuatorTokenMissing", environment, namespace },
    "node_deploy_sequencer_actuator_token_missing"
  );
  throw new Error(
    "AKASH_TX_ACTUATOR_TOKEN is required; the sequencer cannot pay"
  );
}
if (!databaseUrl) {
  log.fatal(
    { reason: "DatabaseUrlMissing", environment, namespace },
    "node_deploy_sequencer_database_url_missing"
  );
  throw new Error("DATABASE_URL is required; deploy state must be durable");
}

const num = (
  raw: string | undefined,
  fallback: number,
  min: number
): number => {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(min, n) : fallback;
};

// The image catalog is the one declaration of which nodes this sequencer deploys in each env (CD1): an env's
// edge guard admits the canary plus every node whose `compute_api[<env>]` is `node-deploy`. No overlay edit is
// needed to onboard a node, and no env override exists.
const catalog = new ImageCatalogNodes({
  root: runtimeEnv.COGNI_IMAGE_ROOT ?? "/app",
});

let lanes: ReturnType<typeof resolveEnvLanes>;
try {
  lanes = resolveEnvLanes({
    deployEnvironment: environment,
    operatorDomainRoot: runtimeEnv.NODE_DEPLOY_OPERATOR_DOMAIN_ROOT,
    podNamespace: namespace,
    environments: runtimeEnv.NODE_DEPLOY_ENVS,
    secretsNamespace: runtimeEnv.NODE_DEPLOY_SECRETS_NAMESPACE,
    substrateHost: runtimeEnv.NODE_DEPLOY_SUBSTRATE_HOST,
    substrateHosts: runtimeEnv.NODE_DEPLOY_SUBSTRATE_HOSTS,
    substrateTransports: runtimeEnv.NODE_DEPLOY_SUBSTRATE_TRANSPORTS,
  });
} catch (error) {
  if (!(error instanceof EnvLaneConfigError)) throw error;
  log.fatal(
    { reason: error.code, namespace, causeMessage: error.message },
    "node_deploy_sequencer_env_lanes_invalid"
  );
  throw error;
}
const appProviders = (runtimeEnv.NODE_DEPLOY_APP_PROVIDERS ?? "")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);

// ONE connection TOTAL: infra/database-budget-profiles.yaml operator-control-v1 budgets exactly one
// for this process and tests/ci-invariants/operator-db-budget.spec.ts counts it. Every env lane shares it.
const db = createAppDbClient(databaseUrl, {
  max: 1,
  applicationName: "cogni_operator_node_deploy_sequencer",
});

// Shared by every env lane: the store, the ONLY payer (the actuator takes the env per request), probes, chain
// truth and Cloudflare. Per env: the edge guard, the secrets namespace and the substrate host.
const store = new PostgresNodeDeployStore(db);
const payer = new ActuatorPayer({
  actuatorUrl:
    runtimeEnv.AKASH_TX_ACTUATOR_URL ?? "http://akash-tx-actuator:8080",
  token: actuatorToken,
});
const probe = new HttpProbe();
const chain = runtimeEnv.AKASH_CHAIN_OWNER
  ? new AkashChainTruth({ owner: runtimeEnv.AKASH_CHAIN_OWNER })
  : undefined;
// The org that owns this fleet's nodes' source repos (the canonical fleet is `cogni-dao`). The SAME filter the
// route applies (`isFleetOwnedRow`): unset admits no remote-source node, so a sequencer that was never told its
// fleet (the test operator) can never claim a host for a canonical node. story.5137 CD4.
const fleetOwner = runtimeEnv.NODE_DEPLOY_FLEET_OWNER?.trim() || undefined;
const images = new GhcrBuiltImageResolver();

/**
 * ONE_EDGE_ZONE: the zone id comes from the bound zone's NAME and the zone-scoped token's own view
 * (`GET /zones?name=`), never from a stored id that may name another zone (the test operator's stored
 * CLOUDFLARE_ZONE_ID need not be cogni-testing.org). The adapter still re-verifies that id/name before use.
 */
async function edgeDnsFor(binding: WorkloadZoneBinding) {
  if (!cfToken) return undefined;
  let zoneId: string;
  try {
    zoneId = await resolveCloudflareZoneId({
      apiToken: cfToken,
      zoneName: binding.zoneName,
    });
  } catch (error) {
    log.error(
      {
        environment,
        edgeZone: binding.zoneName,
        causeMessage:
          error instanceof Error ? error.message.slice(0, 300) : "unknown",
      },
      "node_deploy_sequencer_edge_zone_unresolved"
    );
    return undefined;
  }
  if (cfZone && cfZone !== zoneId)
    log.warn(
      { environment, edgeZone: binding.zoneName, storedZoneId: cfZone, zoneId },
      "node_deploy_sequencer_edge_zone_id_differs: using the id the token resolves for the edge zone"
    );
  return new CloudflareDnsRecords({
    binding,
    apiToken: cfToken,
    zoneId,
    // Re-read the projected token so rotation re-verifies identity; the zone id stays the resolved one.
    readCredentials: async () => ({
      apiToken: await readCredential("CLOUDFLARE_API_TOKEN"),
      zoneId,
    }),
  });
}

/**
 * The tailnet of one lane. A mesh lane mints; an egress lane drains (task.5431 B5): it keeps revoking
 * keys and deleting Secrets of mesh attempts left from a switch-back, and does nothing while none are
 * left (no Headscale call), so a lane with no coordinator stays quiet.
 */
function meshFor(lane: EnvLane) {
  const mode = lane.substrateTransport === "mesh" ? "mint" : "drain";
  const tailnet = lane.meshTailnet;
  log.info(
    {
      environment: lane.environment,
      tailnet,
      mode,
      controlUrl: lane.meshControlUrl,
      socket: headscaleSocketFor(tailnet),
    },
    "node_deploy_sequencer_mesh_lane"
  );
  return {
    mode,
    plane: new MeshPlane(
      new HeadscaleSocketAdapter({ socketPath: headscaleSocketFor(tailnet) }),
      tailnet
    ),
    keys: new KubernetesMeshKeys(lane.secretsNamespace),
    substrateRequests: new HttpsSubstrateRequestSource(
      lane.substrateHost,
      tailnet
    ),
    controlUrl: lane.meshControlUrl ?? "",
  } as const;
}

// Resolve new-effect authority without disabling the existing paid-effect recovery owner.
const composed = await composeNodeDeployLanes({
  fleetOwner,
  zoneName: runtimeEnv.NODE_DEPLOY_WORKLOAD_ZONE,
  lanes,
  dnsRecordsFor: edgeDnsFor,
  nodeDeploySlugs: (env, owner) => catalog.nodeDeploySlugs(env, owner),
  depsForLane: (lane) => {
    const mesh = meshFor(lane);
    return {
      store,
      payer,
      probe,
      images,
      mesh,
      secrets: new KubernetesStatePasswords(
        lane.secretsNamespace,
        lane.environment
      ),
      runtime: {
        secrets: new EsoNodeRuntimeSecrets({
          namespace: lane.secretsNamespace,
        }),
        catalog,
        substrateHost: lane.substrateHost,
        operatorDomain: lane.operatorDomain,
      },
      ...(chain ? { chain } : {}),
      clock: {
        now: () => Date.now(),
        sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      },
      log,
      config: {
        ...DEFAULT_SEQUENCER_CONFIG,
        namespace,
        environment: lane.environment,
        ...(appProviders.length > 0 ? { appProviders } : {}),
        retainMs: num(
          runtimeEnv.NODE_DEPLOY_RETAIN_MS,
          DEFAULT_SEQUENCER_CONFIG.retainMs,
          0
        ),
      },
    };
  },
});
if (!composed.edgeConfigured) {
  log.warn(
    {
      environment,
      namespace,
      reason: composed.authority.ok
        ? "edge_not_configured"
        : composed.authority.reason,
    },
    "node_deploy_sequencer_edge_unconfigured: recovery continues; fresh http apps refused before paying"
  );
}
const laneSequencers = composed.lanes;

/** A failure that repeats every pass is logged once per 10 minutes per (loop, env, message). */
const loopErrorAt = new Map<string, number>();

function reportLoopError(
  name: string,
  error: unknown,
  laneEnvironment?: string
): void {
  const causeMessage =
    error instanceof Error ? error.message.slice(0, 300) : "unknown";
  const k = `${name}/${laneEnvironment ?? ""}/${causeMessage}`;
  const last = loopErrorAt.get(k);
  if (last !== undefined && Date.now() - last < 600_000) return;
  loopErrorAt.set(k, Date.now());
  log.error(
    { loop: name, environment: laneEnvironment, causeMessage },
    "node_deploy_sequencer_loop_threw"
  );
}

// One pass per env, each its own failure domain: a preview fault never stalls production.
const sequencer = new EnvLaneSequencers(
  laneSequencers,
  (laneEnvironment, name, error) =>
    reportLoopError(name, error, laneEnvironment)
);

let leader = false;
let stopping = false;
let timers: NodeJS.Timeout[] = [];

/** Liveness always; readiness only for the process that holds the advisory lock. */
const health = createServer((req, res) => {
  if (req.url === "/healthz" || (req.url === "/readyz" && leader)) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
    return;
  }
  res.writeHead(req.url === "/readyz" ? 503 : 404);
  res.end();
});
health.listen(LISTEN_PORT, "0.0.0.0", () => {
  log.info(
    { namespace, environment, port: LISTEN_PORT },
    "node_deploy_sequencer_listening"
  );
});

/**
 * Take the session advisory lock on the pool's ONE connection and keep proving we still hold it.
 * `postgres.js` recycles connections (idle timeout, no max_lifetime) and a new backend does not carry
 * the old one's session lock, so a "not held" answer first tries to take the lock back ONCE on the same
 * connection; only a refused lock (another process is the leader) is fatal. Checked before every
 * tick/reconcile pass and on a 5 s heartbeat that also keeps the connection from idling out.
 */
const leadership = new AdvisoryLeader(db.$client, log);

function die(reason: string, cause?: unknown): never {
  log.fatal(
    {
      reason,
      causeMessage: cause instanceof Error ? cause.message : undefined,
    },
    "node_deploy_sequencer_leadership_lost"
  );
  process.exit(1);
}

/**
 * LEADER_HEARTBEAT (task.5400 observability): while this process PROVES it still holds the advisory
 * lock it re-emits `node_deploy_sequencer_leader {heartbeat:true}` once a minute. The Grafana alert
 * "no node_deploy_sequencer_leader for 10m" is only meaningful because a healthy leader keeps writing
 * this line; the acquisition line (no `heartbeat`) is written once.
 */
const LEADER_HEARTBEAT_MS = 60_000;
let lastLeaderHeartbeatAt = 0;

async function assertLeader(): Promise<void> {
  try {
    if (!(await leadership.assert())) die("AdvisoryLockHeldByAnotherSession");
  } catch (error) {
    die("LeadershipCheckFailed", error);
  }
  const now = Date.now();
  if (now - lastLeaderHeartbeatAt >= LEADER_HEARTBEAT_MS) {
    lastLeaderHeartbeatAt = now;
    log.info(
      { namespace, environment, heartbeat: true },
      "node_deploy_sequencer_leader"
    );
  }
}

async function acquireLeadership(): Promise<void> {
  for (;;) {
    if (stopping) return;
    if (await leadership.tryAcquire()) break;
    log.info({ namespace }, "node_deploy_sequencer_waiting_for_lock");
    await new Promise((r) => setTimeout(r, 10_000));
  }
  leader = true;
  log.info({ namespace, environment }, "node_deploy_sequencer_leader");
  timers.push(setInterval(() => void assertLeader(), 5_000));
}

function loop(name: string, everyMs: number, work: () => Promise<void>): void {
  const run = (): void => {
    void work()
      .catch((error: unknown) => reportLoopError(name, error))
      .finally(() => {
        if (!stopping) timers.push(setTimeout(run, everyMs));
      });
  };
  run();
}

await acquireLeadership();
loop("tick", TICK_MS, async () => {
  await assertLeader();
  await sequencer.tick();
});
loop("reconcile", RECONCILE_MS, async () => {
  await assertLeader();
  await sequencer.reconcileAll();
});

function shutdown(signal: string): void {
  log.info({ signal }, "node_deploy_sequencer_stopping");
  stopping = true;
  for (const t of timers) clearTimeout(t);
  timers = [];
  health.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
