// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_facades/nodes/operations.server`
 * Purpose: Compose the authenticated principal's node operations read model.
 * Scope: Owner-scoped v0 access resolution, then display-safe deployment/cost/governance reads.
 * Invariants: ACCESS_FIRST, NODE_FILTER_PUSHED_TO_SQL, MODULE_FAILURE_IS_LOCAL, NO_PAYER_INFERENCE.
 * Side-effects: IO
 * Links: /api/v1/dashboard/nodes, task.5112
 * @public
 */

import type { NodeDeployState } from "@cogni/ai-tools";
import { withTenantScope } from "@cogni/db-client";
import { type UserId, userActor } from "@cogni/ids";
import type {
  NodeOperationsOverview,
  NodeOperationsOverviewOutput,
} from "@cogni/node-contracts";
import { getDaoUrl } from "@cogni/node-shared";
import { desc, eq } from "drizzle-orm";

import {
  getContainer,
  resolveAppDb,
  resolveComputeCostStore,
  resolveNodeDeploymentTopology,
  resolveNodeRegistry,
} from "@/bootstrap/container";
import { deriveNodeOperationsStatus } from "@/features/nodes/operations/status";
import { getNodeId } from "@/shared/config";
import { type NodeStatus, nodes } from "@/shared/db/nodes";
import { serverEnv } from "@/shared/env";
import {
  FLIGHT_ENVS,
  hostForEnv,
  rootDomain,
} from "@/shared/node-registry/deploy-hosts";
import { baseDomain, titleCaseSlug } from "@/shared/node-registry/resolve";

type DeploymentModule = NodeOperationsOverview["modules"]["deployment"];
type GovernanceModule = NodeOperationsOverview["modules"]["governance"];
type DeploymentEnvironment = Extract<
  DeploymentModule,
  { state: "available" }
>["environments"][number];

const ENV_LABEL = {
  "candidate-a": "Test",
  preview: "Preview",
  production: "Production",
} as const;

async function readServices(
  reader: ReturnType<typeof resolveNodeDeploymentTopology> | null,
  input: {
    slug: string;
    environment: (typeof FLIGHT_ENVS)[number] | null;
  }
): Promise<DeploymentEnvironment["services"]> {
  if (!reader || input.environment === null) return { state: "unavailable" };
  try {
    const items = await reader.listServices({
      slug: input.slug,
      environment: input.environment,
    });
    return {
      state: "available",
      items: [...items],
    };
  } catch {
    return { state: "unavailable" };
  }
}

async function readDeployment(
  row: {
    id: string;
    slug: string;
    status: NodeStatus;
    deployEnvs: readonly string[];
  },
  homepageUrl: string | null
): Promise<DeploymentModule> {
  if (row.status !== "active") {
    return {
      state: "available",
      status: deriveNodeOperationsStatus(row.status, []),
      homepageUrl: null,
      environments: [],
    };
  }

  const capability = getContainer().deployCapability;
  if (!capability) return { state: "unavailable" };

  const settled = await Promise.allSettled(
    FLIGHT_ENVS.filter((env) => row.deployEnvs.includes(env)).map((env) =>
      capability.getDeployState({ env, node: row.slug })
    )
  );
  const available = settled.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : []
  );
  if (available.length === 0 && row.deployEnvs.length > 0) {
    return { state: "unavailable" };
  }

  const statusInput = FLIGHT_ENVS.map((env) => {
    const state = available.find((item) => item.env === env);
    return {
      env,
      node: row.slug,
      sourceSha: state?.sourceSha ?? null,
      digest: state?.digest ?? null,
      buildSha: state?.buildSha ?? null,
      health: state?.health ?? "unknown",
      replicas: state?.replicas ?? { desired: 0, ready: 0 },
      declared: row.deployEnvs.includes(env),
    } satisfies NodeDeployState & { declared: boolean };
  });

  return {
    state: "available",
    status: deriveNodeOperationsStatus(row.status, statusInput),
    homepageUrl: statusInput.some(
      (state) =>
        state.env === "production" &&
        state.declared &&
        state.health === "healthy"
    )
      ? homepageUrl
      : null,
    environments: statusInput.map((state) => {
      const env = state.env as (typeof FLIGHT_ENVS)[number];
      return {
        env,
        label: ENV_LABEL[env],
        declared: state.declared,
        health: state.health,
        sourceSha: state.sourceSha,
        buildSha: state.buildSha,
        replicas: state.replicas,
        services: { state: "unavailable" },
        compute: { state: "unavailable" },
      };
    }),
  };
}

async function attachDeploymentDetails(input: {
  deployment: DeploymentModule;
  slug: string;
  topologyReader: ReturnType<typeof resolveNodeDeploymentTopology> | null;
  currentEnvironment: (typeof FLIGHT_ENVS)[number] | null;
  cost:
    | {
        activeIntervals: number;
        transferred: readonly { amount: string; denom: string }[];
      }
    | undefined;
  costReadFailed: boolean;
}): Promise<DeploymentModule> {
  if (input.deployment.state === "unavailable") return input.deployment;
  const noCostExpected =
    input.deployment.status === "setting_up" ||
    input.deployment.status === "not_deployed";
  const environments = await Promise.all(
    input.deployment.environments.map(
      async (environment): Promise<DeploymentEnvironment> => ({
        ...environment,
        services: environment.declared
          ? await readServices(input.topologyReader, {
              slug: input.slug,
              environment: environment.env,
            })
          : { state: "unavailable" },
        compute:
          environment.env !== input.currentEnvironment ||
          input.costReadFailed ||
          (!input.cost && !noCostExpected)
            ? { state: "unavailable" }
            : {
                state: "available",
                sponsorship: "cogni",
                activeDeployments: input.cost?.activeIntervals ?? 0,
                transferred: input.cost ? [...input.cost.transferred] : [],
              },
      })
    )
  );
  return { ...input.deployment, environments };
}

async function readGovernance(row: {
  id: string;
  slug: string;
  daoAddress: string | null;
  chainId: number | null;
}): Promise<GovernanceModule> {
  const daoUrl =
    row.daoAddress && row.chainId
      ? getDaoUrl(row.chainId, row.daoAddress)
      : null;
  try {
    const container = getContainer();
    const epochs =
      row.id === getNodeId()
        ? (await container.attributionStore.listEpochs(row.id)).map(
            (epoch) => ({
              id: epoch.id.toString(),
              status: epoch.status,
            })
          )
        : (
            await container.epochsRead.listEpochsForForeignNode(row.slug, {
              limit: 200,
              offset: 0,
            })
          ).epochs.map((epoch) => ({ id: epoch.id, status: epoch.status }));
    const current = epochs
      .filter((epoch) => epoch.status !== "finalized")
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1))[0];
    return {
      state: "available",
      daoUrl,
      finalizedAttributionCredits: { state: "unavailable" },
      totalContributors: { state: "unavailable" },
      epochsCompleted: {
        state: "available",
        value: epochs.filter((epoch) => epoch.status === "finalized").length,
      },
      currentEpoch: {
        state: "available",
        value: current ? { id: current.id, status: current.status } : null,
      },
    };
  } catch {
    // Foreign reads currently fail closed while bug.5167 repairs the slug/node-id handoff.
    // Never replace a foreign node's missing ledger with operator-local zeroes.
    return {
      state: "available",
      daoUrl,
      finalizedAttributionCredits: { state: "unavailable" },
      totalContributors: { state: "unavailable" },
      epochsCompleted: { state: "unavailable" },
      currentEpoch: { state: "unavailable" },
    };
  }
}

function currentDeploymentEnvironment(): (typeof FLIGHT_ENVS)[number] | null {
  const environment = serverEnv().DEPLOY_ENVIRONMENT;
  return FLIGHT_ENVS.find((candidate) => candidate === environment) ?? null;
}

/**
 * V0 resolves the signed-in user's owner relationship first. The response and facade names are
 * principal-neutral so a future OpenFGA-backed developer relationship can reuse the contract.
 */
export async function listAccessibleNodeOperations(
  userId: string
): Promise<NodeOperationsOverviewOutput> {
  const appDb = resolveAppDb();
  const owned = await withTenantScope(
    appDb,
    userActor(userId as UserId),
    async (tx) =>
      tx
        .select({
          id: nodes.id,
          slug: nodes.slug,
          status: nodes.status,
          daoAddress: nodes.daoAddress,
          chainId: nodes.chainId,
          deployEnvs: nodes.deployEnvs,
          createdAt: nodes.createdAt,
        })
        .from(nodes)
        .where(eq(nodes.ownerUserId, userId))
        .orderBy(desc(nodes.createdAt))
        .limit(50)
  );

  // ACCESS_FIRST: do not touch cost evidence until the tenant-scoped query has produced the exact
  // allowed node-id set. The adapter applies this set in SQL via reportByNodeIds().
  const nodeIds = owned.map((node) => node.id);
  if (nodeIds.length === 0) return { nodes: [] };

  const [registryResult, costResult] = await Promise.allSettled([
    resolveNodeRegistry().listPublic(),
    resolveComputeCostStore().reportByNodeIds(nodeIds),
  ]);
  const summaries =
    registryResult.status === "fulfilled" ? registryResult.value : [];
  const summaryById = new Map(
    summaries.flatMap((summary) =>
      summary.nodeId ? [[summary.nodeId, summary] as const] : []
    )
  );
  const costByNode = new Map(
    costResult.status === "fulfilled"
      ? costResult.value.map((report) => [report.nodeId, report] as const)
      : []
  );
  const root = baseDomain(serverEnv());
  const deploymentEnvironment = currentDeploymentEnvironment();
  const currentNodeId = getNodeId();
  let topologyReader: ReturnType<typeof resolveNodeDeploymentTopology> | null =
    null;
  try {
    topologyReader = resolveNodeDeploymentTopology();
  } catch {
    // A missing GitHub App degrades only the declared Services module.
  }

  const overviews = await Promise.all(
    owned.map(async (row): Promise<NodeOperationsOverview> => {
      const summary = summaryById.get(row.id);
      const homepageUrl = root
        ? `https://${hostForEnv(row.slug, row.id === currentNodeId, "production", rootDomain(root))}`
        : summary?.href && /^https?:\/\//.test(summary.href)
          ? summary.href
          : null;
      const [baseDeployment, governance] = await Promise.all([
        readDeployment(
          {
            id: row.id,
            slug: row.slug,
            status: row.status as NodeStatus,
            deployEnvs: row.deployEnvs,
          },
          homepageUrl
        ),
        readGovernance(row),
      ]);
      const cost = costByNode.get(row.id);
      const deployment = await attachDeploymentDetails({
        deployment: baseDeployment,
        slug: row.slug,
        topologyReader,
        currentEnvironment: deploymentEnvironment,
        cost,
        costReadFailed:
          costResult.status === "rejected" || deploymentEnvironment === null,
      });

      return {
        id: row.id,
        slug: row.slug,
        title: summary?.title ?? titleCaseSlug(row.slug),
        icon: summary?.icon ?? null,
        thumbnailUrl: summary?.thumbnailUrl ?? null,
        brandColor: summary?.brandColor ?? null,
        formationStatus: row.status as NodeStatus,
        relationship: "owner",
        detailUrl: `/nodes/${row.id}`,
        modules: { deployment, governance },
      };
    })
  );

  return { nodes: overviews };
}
