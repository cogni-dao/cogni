// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/nodes.operations-overview.v1`
 * Purpose: Display-safe, principal-neutral read contract for the authenticated node operations home.
 * Scope: Zod wire shapes only. Does not authorize, probe runtime health, or persist data.
 * Invariants: NO_INFRA_IDENTIFIERS, MODULE_FAILURE_IS_LOCAL, ACCESS_RELATIONSHIP_IS_EXPLICIT.
 * Side-effects: none
 * Links: /api/v1/dashboard/nodes, task.5112
 * @public
 */

import { z } from "zod";

const moduleUnavailableSchema = z.object({
  state: z.literal("unavailable"),
});

export const nodeOperationsEnvironmentSchema = z.object({
  env: z.enum(["candidate-a", "preview", "production"]),
  label: z.enum(["Test", "Preview", "Production"]),
  declared: z.boolean(),
  health: z.enum(["healthy", "degraded", "provisioning", "unknown"]),
  sourceSha: z.string().nullable(),
  buildSha: z.string().nullable(),
  replicas: z.object({
    desired: z.number().int().nonnegative(),
    ready: z.number().int().nonnegative(),
  }),
});

export const nodeOperationsServicesSchema = z.discriminatedUnion("state", [
  moduleUnavailableSchema,
  z.object({
    state: z.literal("available"),
    /** Environment whose deployed Git branch supplied this topology. */
    environment: z.enum(["candidate-a", "preview", "production"]),
    items: z.array(
      z.object({
        name: z.string().min(1).max(63),
        visibility: z.enum(["public", "private"]),
      })
    ),
  }),
]);

export const nodeOperationsDeploymentModuleSchema = z.discriminatedUnion(
  "state",
  [
    moduleUnavailableSchema,
    z.object({
      state: z.literal("available"),
      status: z.enum([
        "healthy",
        "deploying",
        "needs_attention",
        "not_deployed",
        "setting_up",
      ]),
      homepageUrl: z.string().url().nullable(),
      environments: z.array(nodeOperationsEnvironmentSchema),
    }),
  ]
);

const nativeAmountSchema = z.object({
  amount: z.string(),
  denom: z.string(),
});

export const nodeOperationsComputeModuleSchema = z.discriminatedUnion("state", [
  moduleUnavailableSchema,
  z.object({
    state: z.literal("available"),
    sponsorship: z.literal("cogni"),
    /** Cost evidence belongs only to the operator environment that observed it. */
    environment: z.enum(["candidate-a", "preview", "production"]),
    activeDeployments: z.number().int().nonnegative(),
    transferred: z.array(nativeAmountSchema),
  }),
]);

const unavailableMetricSchema = z.object({ state: z.literal("unavailable") });
const availableCountMetricSchema = z.object({
  state: z.literal("available"),
  value: z.number().int().nonnegative(),
});

const availableCreditMetricSchema = z.object({
  state: z.literal("available"),
  /** Exact display-safe decimal string; never a token or billing balance. */
  value: z.string(),
});

const availableCurrentEpochMetricSchema = z.object({
  state: z.literal("available"),
  value: z
    .object({
      id: z.string(),
      status: z.enum(["open", "review", "finalized"]),
    })
    .nullable(),
});

export const nodeOperationsGovernanceModuleSchema = z.discriminatedUnion(
  "state",
  [
    moduleUnavailableSchema,
    z.object({
      state: z.literal("available"),
      daoUrl: z.string().url().nullable(),
      finalizedAttributionCredits: z.union([
        unavailableMetricSchema,
        availableCreditMetricSchema,
      ]),
      totalContributors: z.union([
        unavailableMetricSchema,
        availableCountMetricSchema,
      ]),
      epochsCompleted: z.union([
        unavailableMetricSchema,
        availableCountMetricSchema,
      ]),
      currentEpoch: z.union([
        unavailableMetricSchema,
        availableCurrentEpochMetricSchema,
      ]),
    }),
  ]
);

/** Reserved, typed module slot. V0 does not populate node-correlated usage. */
export const nodeOperationsUsageModuleSchema = z.discriminatedUnion("state", [
  moduleUnavailableSchema,
  z.object({
    state: z.literal("available"),
    requests30d: z.number().int().nonnegative(),
    activeUsers30d: z.number().int().nonnegative(),
  }),
]);

export const nodeOperationsOverviewSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  title: z.string(),
  icon: z.string().nullable(),
  thumbnailUrl: z.string().url().nullable(),
  brandColor: z.string().nullable(),
  formationStatus: z.enum([
    "dao_pending",
    "dao_formed",
    "published",
    "wallet_ready",
    "payments_ready",
    "active",
    "failed",
  ]),
  relationship: z.enum(["owner", "developer"]),
  detailUrl: z.string(),
  modules: z.object({
    deployment: nodeOperationsDeploymentModuleSchema,
    /** Git-declared topology for this operator environment; independent from runtime probes. */
    services: nodeOperationsServicesSchema,
    compute: nodeOperationsComputeModuleSchema,
    governance: nodeOperationsGovernanceModuleSchema,
    usage: nodeOperationsUsageModuleSchema.optional(),
  }),
});

export const nodeOperationsOverviewOperation = {
  id: "nodes.operations-overview.v1",
  summary: "List node operations visible to the authenticated principal",
  input: z.object({}),
  output: z.object({
    nodes: z.array(nodeOperationsOverviewSchema),
  }),
} as const;

export type NodeOperationsOverview = z.infer<
  typeof nodeOperationsOverviewSchema
>;
export type NodeOperationsOverviewOutput = z.infer<
  typeof nodeOperationsOverviewOperation.output
>;
