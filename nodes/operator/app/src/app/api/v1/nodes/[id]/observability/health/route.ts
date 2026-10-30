// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/observability/health`
 * Purpose: Authenticated, node-scoped ReliabilityStatusV1 read (GET) and human-session
 *   readmission command (POST). Missing evidence returns `unknown`.
 * Scope: Thin shell — session auth, OpenFGA gate, delegate to the reliability actuator,
 *   local fallback, or metrics-derived status.
 * Invariants:
 *   - OBSERVABLE: both verbs run inside `wrapRouteHandlerWithLogging` (routeId
 *     `nodes.observability.health`) with request-logging-only dependencies, so a cold
 *     request with fenced DB roles still logs and never constructs the container (bug.5528).
 *   - TERMINAL_EVENT: each handled request emits exactly one terminal event — GET
 *     `feature.node_observability_health.complete` (state, regionCount, source), POST
 *     `feature.node_observability_health.readmit_complete` (phase) — with outcome,
 *     errorCode, targetNodeId and environment. `nodeId` stays the serving node's binding.
 *     Never the status body, tokens, actors or incident reasons.
 *   - AUTH_UNCHANGED: GET accepts session or bearer (`getSessionUser`); POST accepts only a
 *     human session (`getServerSessionUser`). Both answer a missing identity with 401
 *     `{error:"unauthorized"}`.
 * Side-effects: IO (authz check, actuator/metrics/placement reads, readmission command)
 * Links: src/features/nodes/reliability-status.ts, src/bootstrap/database-reliability-actuator.ts,
 *   task.5247, bug.5528
 * @public
 */

import {
  type ReliabilityStatusV1,
  reliabilityStatusV1Schema,
} from "@cogni/node-contracts";
import { NextResponse } from "next/server";

import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveNodeAndAuthorize } from "@/app/_lib/node-rbac";
import {
  getContainer,
  getRequestLoggingDependencies,
  resolveDatabasePlacementResolver,
  resolveLocalReliabilityControl,
} from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { readReliabilityStatus } from "@/features/nodes/reliability-status";
import { getServerSessionUser } from "@/lib/auth/server";
import type { DatabaseContainmentStatus } from "@/ports";
import { EVENT_NAMES, type RequestContext } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE_ID = "nodes.observability.health";

const ENVIRONMENTS = ["candidate-a", "preview", "production"] as const;
type Environment = (typeof ENVIRONMENTS)[number];

interface RouteParams {
  params: Promise<{ id: string }>;
}

type HealthSource = "actuator" | "local_fallback" | "metrics";

type GateErrorCode = "node_not_found" | "authz_unavailable" | "authz_denied";
type HealthErrorCode =
  | "unauthorized"
  | GateErrorCode
  | "reliability_environment_unavailable"
  | "invalid_env";
type ReadmitErrorCode =
  | "unauthorized"
  | GateErrorCode
  | "invalid_env"
  | "reliability_readmit_unavailable"
  | "reliability_incident_unavailable"
  | "database_recovery_new_incident_required"
  | "reliability_recovery_unavailable";

/**
 * One terminal event per handled request (start + terminal + request-complete = 3 lines).
 * Unhandled throws skip it: the wrapper's `request failed` line is the terminal there.
 * App-local registry names, so this logs via ctx.log directly. The target node is
 * `targetNodeId`: the logger already binds `nodeId` to the serving node.
 * Privacy: enums, ids and counts only — never bodies, incident reasons or actors.
 */
function logTerminal(
  ctx: RequestContext,
  event:
    | typeof EVENT_NAMES.NODE_OBSERVABILITY_HEALTH_COMPLETE
    | typeof EVENT_NAMES.NODE_OBSERVABILITY_HEALTH_READMIT_COMPLETE,
  startedAt: number,
  fields: {
    outcome: "success" | "error";
    status: number;
    errorCode?: HealthErrorCode | ReadmitErrorCode;
    targetNodeId?: string | undefined;
    environment?: string | undefined;
    state?: string;
    regionCount?: number;
    source?: HealthSource;
    phase?: string;
  }
): void {
  const payload = {
    event,
    reqId: ctx.reqId,
    routeId: ctx.routeId,
    durationMs: Math.round(performance.now() - startedAt),
    ...fields,
  };
  const level =
    fields.outcome === "success"
      ? "info"
      : fields.status >= 500
        ? "error"
        : "warn";
  ctx.log[level](payload, event);
}

function isEnvironment(value: string | null | undefined): value is Environment {
  return ENVIRONMENTS.some((candidate) => candidate === value);
}

/** Local identity is image-owned; authorization remains solely OpenFGA. */
async function resolveReliabilityGate(input: {
  id: string;
  userId: string;
  action: "node.flight" | "node.manage_envs";
}) {
  const local = resolveLocalReliabilityControl();
  if (input.id !== local.nodeId && input.id !== local.slug)
    return { ...(await resolveNodeAndAuthorize(input)), local: null };
  const node = { nodeId: local.nodeId, slug: local.slug };
  if (!local.authorization)
    return {
      ok: false as const,
      status: 503,
      errorCode: "authz_unavailable" as const,
      local,
    };
  const decision = await local.authorization.check({
    actorId: `user:${input.userId}`,
    action: input.action,
    resource: `node:${local.nodeId}`,
    context: { tenantId: local.nodeId, nodeId: local.nodeId },
  });
  if (decision.decision !== "allow")
    return {
      ok: false as const,
      status: decision.code === "authz_unavailable" ? 503 : 403,
      errorCode:
        decision.code === "authz_unavailable"
          ? ("authz_unavailable" as const)
          : ("authz_denied" as const),
      local,
    };
  return { ok: true as const, node, local };
}

export const GET = wrapRouteHandlerWithLogging<RouteParams>(
  {
    routeId: ROUTE_ID,
    getRequestDependencies: getRequestLoggingDependencies,
    auth: { mode: "optional", getSessionUser },
  },
  async (ctx, request, user, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const startedAt = performance.now();
    const fail = (status: number, errorCode: HealthErrorCode, body: object) => {
      logTerminal(
        ctx,
        EVENT_NAMES.NODE_OBSERVABILITY_HEALTH_COMPLETE,
        startedAt,
        { outcome: "error", status, errorCode }
      );
      return NextResponse.json(body, { status });
    };

    if (!user) return fail(401, "unauthorized", { error: "unauthorized" });

    const { id } = await context.params;
    const gate = await resolveReliabilityGate({
      id,
      userId: user.id,
      action: "node.flight",
    });
    if (!gate.ok)
      return fail(gate.status, gate.errorCode, { error: gate.errorCode });

    const environment = new URL(request.url).searchParams.get("env");
    // biome-ignore lint/style/noProcessEnv: deployment-local actuator boundary
    const localEnvironment = process.env.DEPLOY_ENVIRONMENT;
    if (!isEnvironment(localEnvironment)) {
      return fail(503, "reliability_environment_unavailable", {
        error: "reliability_environment_unavailable",
      });
    }
    if (!isEnvironment(environment) || environment !== localEnvironment) {
      return fail(400, "invalid_env", {
        error: "invalid_env",
        environment: localEnvironment,
      });
    }

    // A throw here is the wrapper's `request failed` terminal (3-line budget).
    const status = await readHealthStatus(gate, environment);
    logTerminal(
      ctx,
      EVENT_NAMES.NODE_OBSERVABILITY_HEALTH_COMPLETE,
      startedAt,
      {
        outcome: "success",
        status: 200,
        targetNodeId: status.body.nodeId,
        environment: status.body.environment,
        state: status.body.state,
        regionCount: status.body.regionalReadiness.length,
        source: status.source,
      }
    );
    return NextResponse.json(status.body);
  }
);

type ResolvedGate = Extract<
  Awaited<ReturnType<typeof resolveReliabilityGate>>,
  { ok: true }
>;

async function readHealthStatus(
  gate: ResolvedGate,
  environment: Environment
): Promise<{ body: ReliabilityStatusV1; source: HealthSource }> {
  const statusReader =
    gate.local?.statusReader ??
    (gate.local ? undefined : getContainer().reliabilityStatusReader);
  const actuatorStatus = statusReader
    ? await statusReader
        .read({
          nodeId: gate.node.nodeId,
          nodeSlug: gate.node.slug,
          environment,
        })
        .catch(() => null)
    : null;
  if (actuatorStatus) {
    return {
      body: reliabilityStatusV1Schema.parse(actuatorStatus),
      source: "actuator",
    };
  }
  if (gate.local) {
    const placement = gate.local.buildSha
      ? await resolveDatabasePlacementResolver()
          .resolve({
            nodeSlug: gate.node.slug,
            environment,
            sourceRef: gate.local.buildSha,
          })
          .catch(() => null)
      : null;
    return {
      source: "local_fallback",
      body: reliabilityStatusV1Schema.parse({
        version: "reliability-status.v1",
        nodeId: gate.node.nodeId,
        slug: gate.node.slug,
        environment,
        buildSha: gate.local.buildSha,
        databaseTier: placement?.desiredTier ?? "unknown",
        budgetProfile: placement?.budgetProfile ?? null,
        state: "unknown",
        regionalReadiness: [],
        utilization: {
          evidenceScope: "environment-shared",
          ioPressurePct: null,
          connectionPct: null,
          memoryHeadroomPct: null,
          diskHeadroomPct: null,
          databaseShare5m: {
            backendsPct: null,
            physicalReadsPct: null,
            tempBytesPct: null,
          },
        },
        incidentId: null,
        incidentReason: "required reliability evidence is missing",
        observedAt: new Date().toISOString(),
        lastTransitionAt: null,
        evidenceQueryRefs: [],
      }),
    };
  }
  const container = getContainer();

  const deployedBuildSha = container.deployCapability
    ? await container.deployCapability
        .getDeployState({ env: environment, node: gate.node.slug })
        .then((state) => state.buildSha)
        .catch(() => null)
    : null;
  const buildSha =
    deployedBuildSha && /^[0-9a-f]{40}$/.test(deployedBuildSha)
      ? deployedBuildSha
      : null;
  // Catalog intent belongs to the parent operator artifact, not the target
  // node artifact (a Poly SHA is not a commit in this repository).
  // biome-ignore lint/style/noProcessEnv: immutable image metadata boundary
  const catalogBuildSha = process.env.APP_BUILD_SHA;
  const placement =
    catalogBuildSha && /^[0-9a-f]{40}$/.test(catalogBuildSha)
      ? await resolveDatabasePlacementResolver()
          .resolve({
            nodeSlug: gate.node.slug,
            environment,
            sourceRef: catalogBuildSha,
          })
          .catch(() => null)
      : null;
  const database: DatabaseContainmentStatus | null = null;

  const status = await readReliabilityStatus(
    {
      nodeId: gate.node.nodeId,
      slug: gate.node.slug,
      environment,
      buildSha,
      desiredTier: placement?.desiredTier ?? null,
      budgetProfile: placement?.budgetProfile ?? null,
      database,
    },
    container.metricsQuery
  ).catch(() => ({
    version: "reliability-status.v1" as const,
    nodeId: gate.node.nodeId,
    slug: gate.node.slug,
    environment,
    buildSha,
    databaseTier: placement?.desiredTier ?? "unknown",
    budgetProfile: placement?.budgetProfile ?? null,
    state: "unknown" as const,
    regionalReadiness: [],
    utilization: {
      evidenceScope: "environment-shared" as const,
      ioPressurePct: null,
      connectionPct: null,
      memoryHeadroomPct: null,
      diskHeadroomPct: null,
      databaseShare5m: {
        backendsPct: null,
        physicalReadsPct: null,
        tempBytesPct: null,
      },
    },
    incidentId: null,
    incidentReason: "required reliability evidence is missing",
    observedAt: new Date().toISOString(),
    lastTransitionAt: null,
    evidenceQueryRefs: [],
  }));

  return { body: reliabilityStatusV1Schema.parse(status), source: "metrics" };
}

/** Human-session-attributed command; actor identity is never accepted from the body. */
export const POST = wrapRouteHandlerWithLogging<RouteParams>(
  {
    routeId: ROUTE_ID,
    getRequestDependencies: getRequestLoggingDependencies,
    auth: { mode: "optional", getSessionUser: getServerSessionUser },
  },
  async (ctx, request, user, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const startedAt = performance.now();
    let targetNodeId: string | undefined;
    let targetEnvironment: Environment | undefined;
    const fail = (
      status: number,
      errorCode: ReadmitErrorCode,
      body: object
    ) => {
      logTerminal(
        ctx,
        EVENT_NAMES.NODE_OBSERVABILITY_HEALTH_READMIT_COMPLETE,
        startedAt,
        {
          outcome: "error",
          status,
          errorCode,
          targetNodeId,
          environment: targetEnvironment,
        }
      );
      return NextResponse.json(body, { status });
    };

    if (!user) return fail(401, "unauthorized", { error: "unauthorized" });

    const { id } = await context.params;
    const gate = await resolveReliabilityGate({
      id,
      userId: user.id,
      action: "node.manage_envs",
    });
    if (!gate.ok)
      return fail(gate.status, gate.errorCode, { error: gate.errorCode });
    targetNodeId = gate.node.nodeId;

    const body = (await request.json().catch(() => null)) as {
      env?: unknown;
    } | null;
    const environment = body?.env;
    // biome-ignore lint/style/noProcessEnv: deployment-local command boundary
    const localEnvironment = process.env.DEPLOY_ENVIRONMENT;
    if (
      typeof environment !== "string" ||
      !ENVIRONMENTS.includes(environment as Environment) ||
      environment !== localEnvironment
    ) {
      return fail(400, "invalid_env", { error: "invalid_env" });
    }
    targetEnvironment = environment as Environment;

    const command =
      gate.local?.readmit ??
      (gate.local ? undefined : getContainer().reliabilityReadmit);
    const statusReader =
      gate.local?.statusReader ??
      (gate.local ? undefined : getContainer().reliabilityStatusReader);
    if (!command || !statusReader) {
      return fail(503, "reliability_readmit_unavailable", {
        error: "reliability_readmit_unavailable",
      });
    }
    const currentStatus = await statusReader
      .read({
        nodeId: gate.node.nodeId,
        nodeSlug: gate.node.slug,
        environment: targetEnvironment,
      })
      .catch(() => null);
    if (
      currentStatus?.state !== "contained" ||
      !currentStatus.incidentId ||
      !/^reliability\.v1:[a-zA-Z0-9._:-]{1,180}$/.test(currentStatus.incidentId)
    ) {
      return fail(409, "reliability_incident_unavailable", {
        error: "reliability_incident_unavailable",
      });
    }
    const incidentId = currentStatus.incidentId;
    try {
      const result = await command.readmit({
        nodeId: gate.node.nodeId,
        nodeSlug: gate.node.slug,
        environment: targetEnvironment,
        actorId: user.id,
        incidentId,
      });
      const status = result.phase === "recovering" ? 202 : 200;
      logTerminal(
        ctx,
        EVENT_NAMES.NODE_OBSERVABILITY_HEALTH_READMIT_COMPLETE,
        startedAt,
        {
          outcome: "success",
          status,
          targetNodeId,
          environment: targetEnvironment,
          phase: result.phase,
        }
      );
      return NextResponse.json({ ...result, incidentId }, { status });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "database_recovery_new_incident_required"
      ) {
        return fail(409, "database_recovery_new_incident_required", {
          error: error.message,
          incidentId,
        });
      }
      return fail(503, "reliability_recovery_unavailable", {
        error: "reliability_recovery_unavailable",
        state: "unknown",
        incidentId,
      });
    }
  }
);
