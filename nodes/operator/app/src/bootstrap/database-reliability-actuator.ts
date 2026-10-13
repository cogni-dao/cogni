// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/database-reliability-actuator`
 * Purpose: Private autonomous reliability controller and authenticated status readback.
 * Scope: Wires reviewed ports/adapters; does not expose admin credentials or a public route.
 * Invariants: PRIVATE_CREDENTIALS, ONE_MINUTE_SWEEP, FAIL_CLOSED, BOUNDED_TARGET_FAILURES.
 * Side-effects: catalog/Mimir/Loki/Cherry/Postgres IO and a private HTTP listener.
 * Links: task.5247, /api/v1/nodes/{id}/observability/health
 * @internal
 */

import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { ReliabilityStatusV1 } from "@cogni/node-contracts";
import pino from "pino";

import {
  type CherryFenceBinding,
  createProductionDatabaseContainmentAdapter,
  GitHubRepoWriter,
  HttpLokiReader,
  HttpNodeProber,
  MimirMetricsAdapter,
  ProbeDeployAdapter,
} from "@/adapters/server";
import {
  type ReliabilityTarget,
  runReliabilitySweep,
} from "@/features/nodes/reliability-status";

const PORT = 8080;
const SWEEP_INTERVAL_MS = 60_000;
const CREDENTIAL_DIR = "/var/run/secrets/database-reliability";
// biome-ignore lint/style/noProcessEnv: standalone composition root validates its minimal env
const runtimeEnv = process.env;
const log = pino({ level: runtimeEnv.LOG_LEVEL ?? "info" }).child({
  component: "database-reliability-actuator",
  service: "database-reliability-actuator",
});

type Environment = "candidate-a" | "preview" | "production";

function requiredEnv(name: string): string {
  const value = runtimeEnv[name]?.trim();
  if (!value) throw new Error(`database_reliability_missing_env:${name}`);
  return value;
}

async function credential(name: string): Promise<string> {
  const value = await readFile(`${CREDENTIAL_DIR}/${name}`, "utf8")
    .then((text) => text.trim())
    .catch(() => "");
  if (!value)
    throw new Error(`database_reliability_missing_credential:${name}`);
  return value;
}

function parseEnvironment(value: string): Environment {
  if (["candidate-a", "preview", "production"].includes(value))
    return value as Environment;
  throw new Error("database_reliability_environment_invalid");
}

function authorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

function bindingMap(value: string): ReadonlyMap<string, CherryFenceBinding> {
  const parsed = JSON.parse(value) as Record<
    string,
    { ipId?: unknown; serverId?: unknown }
  >;
  const result = new Map<string, CherryFenceBinding>();
  for (const [key, binding] of Object.entries(parsed)) {
    if (
      typeof binding.ipId !== "string" ||
      !Number.isInteger(binding.serverId)
    ) {
      throw new Error(`database_reliability_binding_invalid:${key}`);
    }
    result.set(key, {
      ipId: binding.ipId,
      serverId: binding.serverId as number,
    });
  }
  return result;
}

const environment = parseEnvironment(requiredEnv("DEPLOY_ENVIRONMENT"));
const parentOwner = requiredEnv("NODE_SUBMODULE_PARENT_OWNER");
const parentRepo = requiredEnv("NODE_SUBMODULE_PARENT_REPO");
const rootDomain = requiredEnv("FORK_DOMAIN_ROOT");
const prometheusUrl = requiredEnv("PROMETHEUS_QUERY_URL");
const grafanaUrl = requiredEnv("GRAFANA_URL");
const githubAppId = requiredEnv("GH_REVIEW_APP_ID");

const [
  adminDsn,
  statusToken,
  rawBindings,
  githubPrivateKeyBase64,
  cherryToken,
  prometheusUsername,
  prometheusPassword,
  grafanaToken,
] = await Promise.all([
  credential("DATABASE_RELIABILITY_ADMIN_URL"),
  credential("DATABASE_RELIABILITY_STATUS_TOKEN"),
  credential("DATABASE_RELIABILITY_CHERRY_BINDINGS_JSON"),
  credential("GH_REVIEW_APP_PRIVATE_KEY_BASE64"),
  credential("CHERRY_AUTH_TOKEN"),
  credential("PROMETHEUS_READ_USERNAME"),
  credential("PROMETHEUS_READ_PASSWORD"),
  credential("GRAFANA_SERVICE_ACCOUNT_TOKEN"),
]);

const bindings = bindingMap(rawBindings);
const catalog = new GitHubRepoWriter({
  appId: githubAppId,
  privateKey: Buffer.from(githubPrivateKeyBase64, "base64").toString("utf8"),
  forkDomainRoot: rootDomain,
});
const metrics = new MimirMetricsAdapter({
  url: prometheusUrl,
  username: prometheusUsername,
  password: prometheusPassword,
  timeoutMs: 10_000,
});
const deploy = new ProbeDeployAdapter(new HttpNodeProber(), {
  baseDomain: rootDomain,
  primarySlug: "operator",
});
const containment = createProductionDatabaseContainmentAdapter({
  adminDsn,
  log,
  loki: new HttpLokiReader({ grafanaUrl, token: grafanaToken }),
  lokiEnvironment: environment,
  cherry: {
    authToken: cherryToken,
    timeoutMs: 15_000,
    resolveBinding: async (input) => {
      const binding = bindings.get(`${input.environment}/${input.nodeSlug}`);
      if (!binding) throw new Error("database_source_fence_binding_missing");
      return binding;
    },
  },
});

const statuses = new Map<string, ReliabilityStatusV1>();
let initialSweepComplete = false;
let sweepRunning = false;
let stopping = false;

const statusKey = (target: Pick<ReliabilityTarget, "environment" | "slug">) =>
  `${target.environment}/${target.slug}`;

async function listTargets(): Promise<readonly ReliabilityTarget[]> {
  const nodes = await catalog.listCatalogNodes({
    parentOwner,
    parentRepo,
    sourceRef: "main",
  });
  return nodes.flatMap((node) => {
    const placement = node.databasePlacements[environment];
    if (!placement || !node.deployEnvs.includes(environment)) return [];
    return [
      {
        nodeId: node.nodeId,
        slug: node.slug,
        environment,
        desiredTier: placement.tier,
        budgetProfile: placement.budgetProfile,
      },
    ];
  });
}

async function sweep(): Promise<void> {
  if (sweepRunning || stopping) return;
  sweepRunning = true;
  const startedAt = Date.now();
  try {
    const targets = await listTargets();
    if (targets.length === 0) throw new Error("reliability_targets_empty");
    const minute = Math.floor(Date.now() / SWEEP_INTERVAL_MS);
    const results = await runReliabilitySweep(targets, {
      metrics,
      containment,
      buildShaFor: async (target) =>
        (
          await deploy.getDeployState({
            env: target.environment,
            node: target.slug,
          })
        ).buildSha,
      incidentIdFor: (target) =>
        `reliability.v1:${target.environment}:${target.nodeId}:${minute}`,
    });
    for (const result of results) {
      if (result.status) statuses.set(statusKey(result.target), result.status);
      log[result.error ? "error" : "info"](
        {
          event: "node_reliability_status_complete",
          environment,
          nodeId: result.target.nodeId,
          nodeSlug: result.target.slug,
          state: result.status?.state ?? "unknown",
          outcome: result.error ? "error" : "success",
          reason: result.error,
        },
        "node_reliability_status_complete"
      );
    }
    initialSweepComplete = true;
    log.info(
      {
        event: "database_reliability_sweep_complete",
        environment,
        targets: targets.length,
        failures: results.filter((result) => result.error).length,
        durationMs: Date.now() - startedAt,
      },
      "database_reliability_sweep_complete"
    );
  } catch (error) {
    log.error(
      { event: "database_reliability_sweep_failed", environment, error },
      "database_reliability_sweep_failed"
    );
  } finally {
    sweepRunning = false;
  }
}

const server = createServer((request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(200).end("ok");
    return;
  }
  if (request.url === "/readyz") {
    response
      .writeHead(initialSweepComplete ? 200 : 503)
      .end(initialSweepComplete ? "ready" : "not ready");
    return;
  }
  const url = new URL(request.url ?? "/", "http://actuator.invalid");
  if (request.method !== "GET" || url.pathname !== "/v1/status") {
    response.writeHead(404).end("not found");
    return;
  }
  if (!authorized(request.headers.authorization, statusToken)) {
    response.writeHead(401).end("unauthorized");
    return;
  }
  const nodeSlug = url.searchParams.get("node_slug");
  const nodeId = url.searchParams.get("node_id");
  const requestedEnvironment = url.searchParams.get("environment");
  const status =
    nodeSlug && requestedEnvironment === environment
      ? statuses.get(`${requestedEnvironment}/${nodeSlug}`)
      : undefined;
  if (!status || status.nodeId !== nodeId) {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "reliability_status_unavailable" }));
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(status));
});

server.listen(PORT, "0.0.0.0", () => {
  log.info(
    { event: "database_reliability_actuator_started", environment },
    "database_reliability_actuator_started"
  );
  void sweep();
});
const interval = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(interval);
  log.info({ signal }, "database_reliability_actuator_stopping");
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
