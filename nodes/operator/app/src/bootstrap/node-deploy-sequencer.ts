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
 *   - SINGLE_INSTANCE: a Postgres session advisory lock is held on a reserved connection for the life
 *     of the process. A second replica idles (not ready) and a lost lock connection exits the process;
 *     two sequencers can therefore never drive one workload.
 *   - NO_EDGE_NO_HTTP_APPS: without Cloudflare credentials the process still runs (state workloads work)
 *     and the sequencer refuses http apps BEFORE paying.
 *   - FAIL_LOUD_FOR_ITSELF: a missing actuator token or database URL refuses boot (CrashLoopBackOff).
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
  AkashChainTruth,
  CloudflareDnsRecords,
  HttpProbe,
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
const LOCK_KEY_SQL = "hashtext('node-deploy-sequencer')";

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

const db = createAppDbClient(databaseUrl, {
  max: 4,
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
  secrets: new KubernetesStatePasswords(namespace),
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

/** Reserve one connection and hold the session advisory lock on it for the life of the process. */
async function acquireLeadership(): Promise<void> {
  const reserved = await db.$client.reserve();
  for (;;) {
    if (stopping) return;
    const rows = await reserved.unsafe(
      `select pg_try_advisory_lock(${LOCK_KEY_SQL}) as ok`
    );
    if (rows[0]?.ok === true) break;
    log.info({ namespace }, "node_deploy_sequencer_waiting_for_lock");
    await new Promise((r) => setTimeout(r, 10_000));
  }
  leader = true;
  log.info({ namespace, environment }, "node_deploy_sequencer_leader");
  // A dead lock connection means the lock is gone: exit so a fresh process re-contends.
  timers.push(
    setInterval(() => {
      reserved.unsafe("select 1").catch((error: unknown) => {
        log.fatal(
          { causeMessage: error instanceof Error ? error.message : "unknown" },
          "node_deploy_sequencer_lock_connection_lost"
        );
        process.exit(1);
      });
    }, 30_000)
  );
}

function loop(name: string, everyMs: number, work: () => Promise<void>): void {
  const run = (): void => {
    void work()
      .catch((error: unknown) =>
        log.error(
          {
            loop: name,
            causeMessage: error instanceof Error ? error.message : "unknown",
          },
          "node_deploy_sequencer_loop_threw"
        )
      )
      .finally(() => {
        if (!stopping) timers.push(setTimeout(run, everyMs));
      });
  };
  run();
}

await acquireLeadership();
loop("tick", TICK_MS, () => sequencer.tick());
loop("reconcile", RECONCILE_MS, () => sequencer.reconcileAll());

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
