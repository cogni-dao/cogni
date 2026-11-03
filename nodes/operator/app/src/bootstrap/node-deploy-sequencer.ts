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
 *   - NODE_APP_ENV_NEEDS_ITS_INPUTS (task.5405): `NODE_DEPLOY_SUBSTRATE_HOST` is required, because a node app
 *     deployed without it would run with a half env. Node secrets arrive through the existing custody path
 *     (OpenBao -> ESO -> a Secret in `NODE_DEPLOY_SECRETS_NAMESPACE`); this process holds NO OpenBao
 *     identity and needs no new OpenBao role.
 *   - INTERIM_APP_PROVIDERS (task.5405): `NODE_DEPLOY_APP_PROVIDERS` (comma-separated akash accounts, max 16)
 *     is sent as `allowProviders` on every APP create; unset sends none.
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
  HttpProbe,
  ImageCatalogNodes,
  KubernetesStatePasswords,
  PostgresNodeDeployStore,
} from "@/adapters/server";
import {
  DEFAULT_EDGE_HOST_REGEX,
  EdgeRouter,
} from "@/features/node-deploy/edge";
import {
  DEFAULT_SEQUENCER_CONFIG,
  NodeDeploySequencer,
} from "@/features/node-deploy/sequencer";

const LISTEN_PORT = 8080;
const CREDENTIAL_DIR = "/var/run/secrets/node-deploy-sequencer";
const TICK_MS = 5_000;
const RECONCILE_MS = 60_000;

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

const edgeHostRegex = runtimeEnv.NODE_DEPLOY_EDGE_HOST_REGEX
  ? new RegExp(runtimeEnv.NODE_DEPLOY_EDGE_HOST_REGEX)
  : DEFAULT_EDGE_HOST_REGEX;
const edge =
  cfToken && cfZone
    ? new EdgeRouter(
        new CloudflareDnsRecords({ apiToken: cfToken, zoneId: cfZone }),
        edgeHostRegex
      )
    : undefined;
if (!edge) {
  log.warn(
    { environment, namespace },
    "node_deploy_sequencer_edge_unconfigured: http apps will be refused before paying"
  );
}

const secretsNamespace = runtimeEnv.NODE_DEPLOY_SECRETS_NAMESPACE;
if (!secretsNamespace || secretsNamespace === namespace) {
  log.fatal(
    { reason: "SecretsNamespaceInvalid", namespace, secretsNamespace },
    "node_deploy_sequencer_secrets_namespace_invalid"
  );
  throw new Error(
    "NODE_DEPLOY_SECRETS_NAMESPACE is required and must NOT be the pod's own (wallet) namespace"
  );
}

const substrateHost = runtimeEnv.NODE_DEPLOY_SUBSTRATE_HOST;
if (!substrateHost) {
  log.fatal(
    { reason: "NodeAppRuntimeInputsMissing" },
    "node_deploy_sequencer_node_app_runtime_unconfigured"
  );
  throw new Error(
    "NODE_DEPLOY_SUBSTRATE_HOST is required; a node app would run with a half env"
  );
}
const appProviders = (runtimeEnv.NODE_DEPLOY_APP_PROVIDERS ?? "")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);

// ONE connection TOTAL: infra/database-budget-profiles.yaml operator-control-v1 budgets exactly one
// for this process and tests/ci-invariants/operator-db-budget.spec.ts counts it.
const db = createAppDbClient(databaseUrl, {
  max: 1,
  applicationName: "cogni_operator_node_deploy_sequencer",
});

const sequencer = new NodeDeploySequencer({
  store: new PostgresNodeDeployStore(db),
  payer: new ActuatorPayer({
    actuatorUrl:
      runtimeEnv.AKASH_TX_ACTUATOR_URL ?? "http://akash-tx-actuator:8080",
    token: actuatorToken,
  }),
  edge,
  probe: new HttpProbe(),
  secrets: new KubernetesStatePasswords(secretsNamespace, environment),
  runtime: {
    secrets: new EsoNodeRuntimeSecrets({ namespace: secretsNamespace }),
    catalog: new ImageCatalogNodes({
      root: runtimeEnv.COGNI_IMAGE_ROOT ?? "/app",
    }),
    substrateHost,
  },
  ...(runtimeEnv.AKASH_CHAIN_OWNER
    ? { chain: new AkashChainTruth({ owner: runtimeEnv.AKASH_CHAIN_OWNER }) }
    : {}),
  clock: {
    now: () => Date.now(),
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  },
  log,
  config: {
    ...DEFAULT_SEQUENCER_CONFIG,
    namespace,
    environment,
    ...(appProviders.length > 0 ? { appProviders } : {}),
    retainMs: num(
      runtimeEnv.NODE_DEPLOY_RETAIN_MS,
      DEFAULT_SEQUENCER_CONFIG.retainMs,
      0
    ),
  },
});

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

/** A failure that repeats every pass is logged once per 10 minutes per (loop, message). */
const loopErrorAt = new Map<string, number>();

function loop(name: string, everyMs: number, work: () => Promise<void>): void {
  const run = (): void => {
    void work()
      .catch((error: unknown) => {
        const causeMessage =
          error instanceof Error ? error.message.slice(0, 300) : "unknown";
        const k = `${name}/${causeMessage}`;
        const last = loopErrorAt.get(k);
        if (last !== undefined && Date.now() - last < 600_000) return;
        loopErrorAt.set(k, Date.now());
        log.error(
          { loop: name, causeMessage },
          "node_deploy_sequencer_loop_threw"
        );
      })
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
