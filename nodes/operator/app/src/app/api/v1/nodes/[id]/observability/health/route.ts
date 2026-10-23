// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/** Authenticated, node-scoped ReliabilityStatusV1 read. Missing evidence returns unknown. */

import { reliabilityStatusV1Schema } from "@cogni/node-contracts";
import { NextResponse } from "next/server";

import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveNodeAndAuthorize } from "@/app/_lib/node-rbac";
import {
  getContainer,
  resolveDatabasePlacementResolver,
  resolveLocalReliabilityControl,
} from "@/bootstrap/container";
import { readReliabilityStatus } from "@/features/nodes/reliability-status";
import { getServerSessionUser } from "@/lib/auth/server";
import type { DatabaseContainmentStatus } from "@/ports";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ENVIRONMENTS = ["candidate-a", "preview", "production"] as const;
type Environment = (typeof ENVIRONMENTS)[number];

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
      errorCode: "authz_unavailable",
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
          ? "authz_unavailable"
          : "authz_denied",
      local,
    };
  return { ok: true as const, node, local };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const user = await getSessionUser();
  if (!user)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const gate = await resolveReliabilityGate({
    id,
    userId: user.id,
    action: "node.flight",
  });
  if (!gate.ok)
    return NextResponse.json(
      { error: gate.errorCode },
      { status: gate.status }
    );

  const environment = new URL(request.url).searchParams.get("env");
  // biome-ignore lint/style/noProcessEnv: deployment-local actuator boundary
  const localEnvironment = process.env.DEPLOY_ENVIRONMENT;
  if (!isEnvironment(localEnvironment)) {
    return NextResponse.json(
      { error: "reliability_environment_unavailable" },
      { status: 503 }
    );
  }
  if (!isEnvironment(environment) || environment !== localEnvironment) {
    return NextResponse.json(
      { error: "invalid_env", environment: localEnvironment },
      { status: 400 }
    );
  }

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
    return NextResponse.json(reliabilityStatusV1Schema.parse(actuatorStatus));
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
    return NextResponse.json(
      reliabilityStatusV1Schema.parse({
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
      })
    );
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
    // bug.5519: nodes outside the actuator sweep read the same governed
    // Grafana datasource authority, never the unconfigured Basic-auth port.
    container.reliabilityMetrics
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

  return NextResponse.json(reliabilityStatusV1Schema.parse(status));
}

/** Human-session-attributed command; actor identity is never accepted from the body. */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const user = await getServerSessionUser();
  if (!user)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const gate = await resolveReliabilityGate({
    id,
    userId: user.id,
    action: "node.manage_envs",
  });
  if (!gate.ok) {
    return NextResponse.json(
      { error: gate.errorCode },
      { status: gate.status }
    );
  }

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
    return NextResponse.json({ error: "invalid_env" }, { status: 400 });
  }

  const command =
    gate.local?.readmit ??
    (gate.local ? undefined : getContainer().reliabilityReadmit);
  const statusReader =
    gate.local?.statusReader ??
    (gate.local ? undefined : getContainer().reliabilityStatusReader);
  if (!command || !statusReader) {
    return NextResponse.json(
      { error: "reliability_readmit_unavailable" },
      { status: 503 }
    );
  }
  const currentStatus = await statusReader
    .read({
      nodeId: gate.node.nodeId,
      nodeSlug: gate.node.slug,
      environment: environment as Environment,
    })
    .catch(() => null);
  if (
    currentStatus?.state !== "contained" ||
    !currentStatus.incidentId ||
    !/^reliability\.v1:[a-zA-Z0-9._:-]{1,180}$/.test(currentStatus.incidentId)
  ) {
    return NextResponse.json(
      { error: "reliability_incident_unavailable" },
      { status: 409 }
    );
  }
  const incidentId = currentStatus.incidentId;
  try {
    const result = await command.readmit({
      nodeId: gate.node.nodeId,
      nodeSlug: gate.node.slug,
      environment: environment as Environment,
      actorId: user.id,
      incidentId,
    });
    return NextResponse.json(
      { ...result, incidentId },
      { status: result.phase === "recovering" ? 202 : 200 }
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "database_recovery_new_incident_required"
    ) {
      return NextResponse.json(
        { error: error.message, incidentId },
        { status: 409 }
      );
    }
    return NextResponse.json(
      {
        error: "reliability_recovery_unavailable",
        state: "unknown",
        incidentId,
      },
      { status: 503 }
    );
  }
}
