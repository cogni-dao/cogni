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
} from "@/bootstrap/container";
import { readReliabilityStatus } from "@/features/nodes/reliability-status";
import type { DatabaseContainmentStatus } from "@/ports";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ENVIRONMENTS = ["candidate-a", "preview", "production"] as const;
type Environment = (typeof ENVIRONMENTS)[number];

function isEnvironment(value: string | null): value is Environment {
  return ENVIRONMENTS.some((candidate) => candidate === value);
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const user = await getSessionUser();
  if (!user)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const gate = await resolveNodeAndAuthorize({
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
  if (!isEnvironment(environment)) {
    return NextResponse.json(
      { error: "invalid_env", environments: ENVIRONMENTS },
      { status: 400 }
    );
  }

  const container = getContainer();
  const actuatorStatus = container.reliabilityStatusReader
    ? await container.reliabilityStatusReader
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

  const placement = await resolveDatabasePlacementResolver()
    .resolve({ nodeSlug: gate.node.slug, environment })
    .catch(() => null);
  const buildSha = container.deployCapability
    ? await container.deployCapability
        .getDeployState({ env: environment, node: gate.node.slug })
        .then((state) => state.buildSha)
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
      ioPressurePct: null,
      connectionPct: null,
      memoryHeadroomPct: null,
      diskHeadroomPct: null,
    },
    incidentReason: "required reliability evidence is missing",
    lastTransitionAt: null,
    evidenceQueryRefs: [],
  }));

  return NextResponse.json(reliabilityStatusV1Schema.parse(status));
}
