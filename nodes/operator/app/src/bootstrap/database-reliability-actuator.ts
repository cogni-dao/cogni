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
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { ReliabilityStatusV1 } from "@cogni/node-contracts";
import pino from "pino";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import {
  MimirMetricsAdapter,
  PinoDatabaseContainmentAuditWriter,
  PostgresAdminSqlAdapter,
  PostgresDatabaseContainmentControlAdapter,
  PostgresDatabaseRecoveryProbeAdapter,
  RecoveryLedgerDatabaseContainmentAdapter,
} from "@/adapters/server";
import {
  isReliabilitySweepReady,
  RELIABILITY_EVIDENCE_TTL_MS,
  type ReliabilityTarget,
  runReliabilitySweep,
} from "@/features/nodes/reliability-status";
import type {} from "@/ports";
import { hostForEnv } from "@/shared/node-registry/deploy-hosts";
import { EVENT_NAMES } from "@/shared/observability";

const SWEEP_INTERVAL_MS = 60_000;
const CREDENTIAL_DIR = "/var/run/secrets/database-reliability";
const CATALOG_DIR = "/app/infra/catalog";
// biome-ignore lint/style/noProcessEnv: standalone composition root validates its minimal env
const runtimeEnv = process.env;
type Environment = "candidate-a" | "preview" | "production";
type RuntimeMode = "sweep" | "readmit";

const ReliabilityControllerCatalogSchema = z.object({
  type: z.literal("node"),
  name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  path_prefix: z.string().regex(/^[a-z0-9._/-]+\/$/),
  source_repo: z.never().optional(),
  is_primary_host: z.literal(true),
  reliability: z.object({ controller: z.literal(true) }),
});

const CatalogIdentitySchema = z
  .object({
    nodeId: z.string().uuid(),
  })
  .or(
    z
      .object({ node_id: z.string().uuid() })
      .transform((value) => ({ nodeId: value.node_id }))
  );

async function resolveReliabilityController(): Promise<{
  slug: string;
  nodeId: string;
}> {
  const files = (await readdir(CATALOG_DIR)).filter((name) =>
    name.endsWith(".yaml")
  );
  const matches: Array<{ slug: string; pathPrefix: string }> = [];
  for (const name of files) {
    const raw = parseYaml(await readFile(`${CATALOG_DIR}/${name}`, "utf8"));
    if (raw?.reliability?.controller !== true) continue;
    const row = ReliabilityControllerCatalogSchema.parse(raw);
    matches.push({ slug: row.name, pathPrefix: row.path_prefix });
  }
  if (matches.length !== 1)
    throw new Error("reliability_catalog_controller_not_unique");
  const controller = matches[0];
  if (!controller) throw new Error("reliability_catalog_controller_missing");
  const identity = CatalogIdentitySchema.parse(
    parseYaml(
      await readFile(
        `/app/${controller.pathPrefix}.cogni/repo-spec.yaml`,
        "utf8"
      )
    )
  );
  return { slug: controller.slug, nodeId: identity.nodeId };
}

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

function parseBuildSha(value: string): string {
  if (/^[0-9a-f]{40}$/.test(value)) return value;
  throw new Error("database_reliability_build_sha_invalid");
}

function parseRuntimeMode(value: string): RuntimeMode {
  if (value === "sweep" || value === "readmit") return value;
  throw new Error("database_reliability_mode_invalid");
}

function authorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

const environment = parseEnvironment(requiredEnv("DEPLOY_ENVIRONMENT"));
const buildSha = parseBuildSha(requiredEnv("APP_BUILD_SHA"));
const mode = parseRuntimeMode(requiredEnv("DATABASE_RELIABILITY_MODE"));
const reliabilityController = await resolveReliabilityController();
const port = mode === "sweep" ? 8080 : 8081;
const log = pino({ level: runtimeEnv.LOG_LEVEL ?? "info" }).child({
  buildSha,
  component: `database-reliability-${mode}`,
  service:
    mode === "sweep"
      ? "database-reliability-actuator"
      : "database-reliability-readmitter",
});
const rootDomain = requiredEnv("FORK_DOMAIN_ROOT");
const prometheusUrl = requiredEnv("PROMETHEUS_QUERY_URL");
const [statusToken, prometheusUsername, prometheusPassword] = await Promise.all(
  [
    credential("DATABASE_RELIABILITY_STATUS_TOKEN"),
    credential("PROMETHEUS_READ_USERNAME"),
    credential("PROMETHEUS_READ_PASSWORD"),
  ]
);
const adminDsn =
  mode === "sweep" ? await credential("DATABASE_RELIABILITY_ADMIN_URL") : null;
const readmitToken =
  mode === "readmit"
    ? await credential("DATABASE_RELIABILITY_READMIT_TOKEN")
    : null;

const metrics = new MimirMetricsAdapter({
  url: prometheusUrl,
  username: prometheusUsername,
  password: prometheusPassword,
  timeoutMs: 10_000,
});
const recoveryProbes =
  mode === "sweep"
    ? new PostgresDatabaseRecoveryProbeAdapter(
        JSON.parse(await credential("DATABASE_RECOVERY_PROBE_URLS_JSON"))
      )
    : null;
const recoveryVerifier =
  mode === "sweep" && adminDsn
    ? new PostgresDatabaseContainmentControlAdapter(
        new PostgresAdminSqlAdapter(adminDsn)
      )
    : null;
const containment =
  recoveryProbes && recoveryVerifier
    ? new RecoveryLedgerDatabaseContainmentAdapter({
        ledger: recoveryVerifier,
        probe: recoveryProbes,
        audit: new PinoDatabaseContainmentAuditWriter(log),
        targetBuildShaFor: (input) => {
          const target = [...currentTargets.values()].find(
            (row) =>
              row.nodeId === input.nodeId &&
              row.environment === input.environment
          );
          if (!target)
            throw new Error("database_recovery_catalog_target_missing");
          return target.sourceSha;
        },
      })
    : null;

const statuses = new Map<string, ReliabilityStatusV1>();
let currentTargets = new Map<string, ReliabilityTarget>();
let lastCompleteSweepAt: number | null = null;
let sweepRunning = false;
let stopping = false;

const statusKey = (target: Pick<ReliabilityTarget, "environment" | "slug">) =>
  `${target.environment}/${target.slug}`;

function targetOrigin(target: ReliabilityTarget): string {
  return `https://${hostForEnv(target.slug, target.slug === reliabilityController.slug, target.environment, rootDomain)}`;
}

async function readTargetBuildSha(
  target: ReliabilityTarget
): Promise<string | null> {
  try {
    const response = await fetch(new URL("/version", targetOrigin(target)), {
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const result = z
      .object({ buildSha: z.string().regex(/^[0-9a-f]{40}$/) })
      .parse(await response.json());
    return result.buildSha;
  } catch {
    return null;
  }
}

async function listTargets(): Promise<readonly ReliabilityTarget[]> {
  const files = (await readdir(CATALOG_DIR)).filter((name) =>
    name.endsWith(".yaml")
  );
  const nodes = await Promise.all(
    files.map(async (name) =>
      CatalogEntrySchema.parse(
        parseYaml(await readFile(`${CATALOG_DIR}/${name}`, "utf8"))
      )
    )
  );
  return nodes.flatMap((node) => {
    if (node.type !== "node") return [];
    const placement = node.databasePlacements[environment];
    if (!placement || !node.deployEnvs.includes(environment)) return [];
    const nodeId =
      node.nodeId ??
      (node.isReliabilityController ? reliabilityController.nodeId : undefined);
    if (!nodeId)
      throw new Error(`reliability_catalog_node_id_missing:${node.slug}`);
    const sourceSha =
      node.sourceSha ?? (node.isReliabilityController ? buildSha : undefined);
    if (!sourceSha)
      throw new Error(`reliability_catalog_source_sha_missing:${node.slug}`);
    let substrateHost: string | undefined;
    if (recoveryProbes) {
      try {
        substrateHost = recoveryProbes.bindingFor({
          nodeId,
          nodeSlug: node.slug,
          environment,
        }).substrateHost;
      } catch {
        log.warn(
          { nodeId, nodeSlug: node.slug, environment },
          "database_recovery_probe_binding_missing"
        );
      }
    }
    return [
      {
        nodeId,
        slug: node.slug,
        environment,
        desiredTier: placement.tier,
        budgetProfile: placement.budgetProfile,
        sourceSha,
        ...(substrateHost ? { substrateHost } : {}),
      },
    ];
  });
}

const CatalogEntrySchema = z
  .object({
    type: z.string(),
    name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    node_id: z.string().uuid().optional(),
    source_sha: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional(),
    reliability: z.object({ controller: z.boolean().optional() }).optional(),
    envs: z.array(z.enum(["candidate-a", "preview", "production"])).default([]),
    database: z
      .record(
        z.string(),
        z.object({
          tier: z.enum(["shared", "dedicated"]),
          budget_profile: z.string().min(1),
        })
      )
      .default({}),
  })
  .transform((value) => ({
    type: value.type,
    slug: value.name,
    nodeId: value.node_id,
    sourceSha: value.source_sha,
    isReliabilityController: value.reliability?.controller === true,
    deployEnvs: value.envs,
    databasePlacements: Object.fromEntries(
      Object.entries(value.database).map(([key, placement]) => [
        key,
        {
          tier: placement.tier,
          budgetProfile: placement.budget_profile,
        },
      ])
    ) as Partial<
      Record<
        Environment,
        { tier: "shared" | "dedicated"; budgetProfile: string }
      >
    >,
  }));

async function sweep(): Promise<void> {
  if (sweepRunning || stopping) return;
  if (!containment) throw new Error("database_reliability_sweep_unavailable");
  sweepRunning = true;
  const startedAt = Date.now();
  try {
    const catalogTargets = (await listTargets()).filter((target) =>
      Boolean(target.substrateHost)
    );
    if (catalogTargets.length === 0)
      throw new Error("reliability_targets_empty");
    const nextTargets = new Map(
      catalogTargets.map((target) => [statusKey(target), target] as const)
    );
    currentTargets = nextTargets;
    for (const key of statuses.keys()) {
      if (!nextTargets.has(key)) statuses.delete(key);
    }
    const minute = Math.floor(Date.now() / SWEEP_INTERVAL_MS);
    const results = await runReliabilitySweep(catalogTargets, {
      metrics,
      containment,
      buildShaFor: async (target) => readTargetBuildSha(target),
      incidentIdFor: (target) =>
        `reliability.v1:${target.environment}:${target.nodeId}:${minute}`,
    });
    for (const result of results) {
      if (result.status) statuses.set(statusKey(result.target), result.status);
      log[result.error ? "error" : "info"](
        {
          event: EVENT_NAMES.NODE_RELIABILITY_STATUS_COMPLETE,
          environment,
          nodeId: result.target.nodeId,
          nodeSlug: result.target.slug,
          buildSha: result.status?.buildSha ?? null,
          databaseTier:
            result.status?.databaseTier ?? result.target.desiredTier,
          budgetProfile:
            result.status?.budgetProfile ?? result.target.budgetProfile,
          state: result.status?.state ?? "unknown",
          evidenceScope:
            result.status?.utilization.evidenceScope ?? "environment-shared",
          databaseShare5m: result.status?.utilization.databaseShare5m ?? null,
          observedAt: result.status?.observedAt ?? null,
          outcome: result.error ? "error" : "success",
          reason: result.error,
        },
        EVENT_NAMES.NODE_RELIABILITY_STATUS_COMPLETE
      );
    }
    const complete = results.every(
      (result) => result.error === null && result.status !== null
    );
    lastCompleteSweepAt = complete ? Date.now() : null;
    log.info(
      {
        event: EVENT_NAMES.NODE_RELIABILITY_SWEEP_COMPLETE,
        environment,
        targets: catalogTargets.length,
        failures: results.filter((result) => result.error).length,
        durationMs: Date.now() - startedAt,
      },
      EVENT_NAMES.NODE_RELIABILITY_SWEEP_COMPLETE
    );
  } catch (error) {
    lastCompleteSweepAt = null;
    log.error(
      { event: EVENT_NAMES.NODE_RELIABILITY_SWEEP_FAILED, environment, error },
      EVENT_NAMES.NODE_RELIABILITY_SWEEP_FAILED
    );
  } finally {
    sweepRunning = false;
  }
}

const server = createServer(async (request, response) => {
  try {
    if (request.url === "/healthz") {
      response.writeHead(200).end("ok");
      return;
    }
    if (request.url === "/readyz") {
      if (mode === "readmit") {
        // Listener readiness is independent of the deliberately disabled LOGIN capability.
        response
          .writeHead(200)
          .end("ready; readmission disabled pending recovery proof");
        return;
      }
      const ready = isReliabilitySweepReady({
        nowMs: Date.now(),
        lastCompleteSweepAt,
        targetKeys: new Set(currentTargets.keys()),
        statusKeys: new Set(statuses.keys()),
      });
      response.writeHead(ready ? 200 : 503).end(ready ? "ready" : "not ready");
      return;
    }
    if (request.method === "GET" && request.url === "/version") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ buildSha }));
      return;
    }
    const url = new URL(request.url ?? "/", "http://actuator.invalid");
    const isPublicStatus =
      request.method === "GET" && url.pathname === "/v1/status";
    const isInternalStatus =
      request.method === "GET" && url.pathname === "/v1/internal/status";
    const isSubstrate =
      request.method === "GET" && url.pathname === "/v1/internal/substrate";
    const isReadmit =
      request.method === "POST" && url.pathname === "/v1/readmit";
    const routeAllowed =
      (mode === "sweep" &&
        (isPublicStatus || isInternalStatus || isSubstrate)) ||
      (mode === "readmit" && isReadmit);
    if (!routeAllowed) {
      response.writeHead(404).end("not found");
      return;
    }
    const requiredToken = mode === "sweep" ? statusToken : readmitToken;
    if (!requiredToken) {
      throw new Error("database_reliability_runtime_token_missing");
    }
    if (!authorized(request.headers.authorization, requiredToken)) {
      response.writeHead(401).end("unauthorized");
      return;
    }
    const nodeSlug = url.searchParams.get("node_slug");
    const nodeId = url.searchParams.get("node_id");
    const requestedEnvironment = url.searchParams.get("environment");
    const key = `${requestedEnvironment}/${nodeSlug}`;
    const target =
      nodeSlug && requestedEnvironment === environment
        ? mode === "sweep"
          ? currentTargets.get(key)
          : (await listTargets()).find(
              (candidate) => statusKey(candidate) === key
            )
        : undefined;
    if (!target || target.nodeId !== nodeId) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "reliability_status_unavailable" }));
      return;
    }
    if (isSubstrate) {
      if (!recoveryProbes)
        throw new Error("database_recovery_probe_unavailable");
      const startedAt = performance.now();
      const binding = recoveryProbes.bindingFor({
        nodeId: target.nodeId,
        nodeSlug: target.slug,
        environment,
      });
      const observed = await recoveryProbes.observe({
        nodeId: target.nodeId,
        nodeSlug: target.slug,
        environment,
      });
      if (!observed.systemTenantExists)
        throw new Error("database_recovery_system_tenant_missing");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          substrateHost: binding.substrateHost,
          databaseSystemIdentifier: observed.systemIdentifier,
          databaseName: observed.database,
          serverAddress: observed.serverAddress,
          serverPort: observed.serverPort,
          latencyMs: performance.now() - startedAt,
          observedAt: observed.observedAt,
        })
      );
      return;
    }
    if (isPublicStatus) {
      const status = statuses.get(key);
      const statusAgeMs = status
        ? Date.now() - Date.parse(status.observedAt)
        : Number.POSITIVE_INFINITY;
      if (
        !status ||
        statusAgeMs < -15_000 ||
        statusAgeMs > RELIABILITY_EVIDENCE_TTL_MS
      ) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: "reliability_status_unavailable" })
        );
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(status));
      return;
    }

    const containmentInput = {
      nodeId: target.nodeId,
      nodeSlug: target.slug,
      environment: target.environment,
      desiredTier: target.desiredTier,
      budgetProfile: target.budgetProfile,
      ...(target.cellId ? { cellId: target.cellId } : {}),
    };
    if (isInternalStatus) {
      if (!containment) {
        throw new Error("database_reliability_sweep_unavailable");
      }
      const status = await containment.status(containmentInput);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(status));
      return;
    }

    const actorId = request.headers["x-cogni-actor-id"];
    const incidentId = request.headers["x-cogni-incident-id"];
    if (
      typeof actorId !== "string" ||
      !/^human:[a-zA-Z0-9._@:-]{1,120}$/.test(actorId) ||
      typeof incidentId !== "string" ||
      !/^reliability\.v1:[a-zA-Z0-9._:-]{1,180}$/.test(incidentId)
    ) {
      response.writeHead(400).end("invalid readmission attribution");
      return;
    }
    // The first shared proof leaves the incident fenced. LOGIN remains unavailable
    // until independent deadline enforcement and the scoped regional protocol are proven.
    response.writeHead(503, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: "database_recovery_deadline_owner_unproven",
        incidentId,
      })
    );
  } catch (error) {
    log.error(
      { event: EVENT_NAMES.NODE_RELIABILITY_HTTP_FAILED, error },
      EVENT_NAMES.NODE_RELIABILITY_HTTP_FAILED
    );
    if (!response.headersSent) {
      response.writeHead(503, { "content-type": "application/json" });
    }
    response.end(
      JSON.stringify({ error: "database_reliability_request_failed" })
    );
  }
});

server.listen(port, "0.0.0.0", () => {
  log.info(
    {
      event: EVENT_NAMES.NODE_RELIABILITY_ACTUATOR_STARTED,
      environment,
      buildSha,
    },
    EVENT_NAMES.NODE_RELIABILITY_ACTUATOR_STARTED
  );
  if (mode === "sweep") void sweep();
});
const interval =
  mode === "sweep" ? setInterval(() => void sweep(), SWEEP_INTERVAL_MS) : null;

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (interval) clearInterval(interval);
  log.info(
    { event: EVENT_NAMES.NODE_RELIABILITY_ACTUATOR_STOPPING, signal },
    EVENT_NAMES.NODE_RELIABILITY_ACTUATOR_STOPPING
  );
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
