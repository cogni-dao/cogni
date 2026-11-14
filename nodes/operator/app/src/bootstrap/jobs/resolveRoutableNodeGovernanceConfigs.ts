// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/jobs/resolveRoutableNodeGovernanceConfigs`
 * Purpose: Enumerate every routable node and synthesize its epoch-collect dispatch schedule, so the
 *   operator can schedule `NodeTaskWorkflow(/api/internal/attribution/collect)` INTO each node. The
 *   dispatch payload is only `{ nodeId }`; the NODE self-serves its own ledger config in
 *   `runCollectPass` (NODE_WRITES_OWN_LEDGER), so the operator does NOT read the node's repo-spec.
 * Scope: Service-role (non-RLS) DB read of locally deployed `nodes` in ('published','active') whose
 *   singleton `activity_env` equals this process's `DEPLOY_ENVIRONMENT`. NO GitHub App reads, NO deploy
 *   plane, NO monorepo git dependency — a freshly-provisioned env dispatches from its projected registry.
 * Invariants:
 *   - NODE_OWNS_ITS_LEDGER: the operator never reads a node's ledger/cron from git; it dispatches
 *     `{ nodeId }` and the node builds the collect envelope from ITS OWN repo-spec (the node's
 *     `/api/internal/attribution/collect` route — NODE_WRITES_OWN_LEDGER).
 *   - COLLECT_CADENCE_DEFAULT: the operator polls each node's collect on a fixed daily cadence
 *     (mirrors the operator's own LEDGER_INGEST cron in `.cogni/repo-spec.yaml`). `ensureEpochForWindow`
 *     is idempotent, so a poll cadence is safe regardless of the node's own epoch length.
 *   - FAIL_SOFT_PER_NODE: a node with no `activity_ledger` fail-softs (its `/collect` returns 400
 *     "ledger config not present"); a node without the receiver route 404s. The at-most-once dispatch
 *     absorbs both — no schedule creation is blocked.
 *   - NO_MONOREPO_GIT_READ: replaces the prior per-node App-read of `.cogni/repo-spec.yaml`, which
 *     404'd on any env where the operator App is not installed on the node's parent repo — the bug
 *     that produced ZERO dispatch schedules (and thus no node epochs) on candidate-a (story.5001).
 *   - LOCAL_ACTIVITY_AUTHORITY_ONLY: a row schedules only when `DEPLOY_ENVIRONMENT` is in
 *     `deploy_envs` AND equals `activity_env`. Multi-env deployment never means multi-env scheduling.
 * Side-effects: IO (service-DB read of `nodes`).
 * Links: packages/scheduler-core/src/services/syncGovernanceSchedules.ts,
 *   node-template `app/src/app/api/internal/attribution/collect/route.ts` (the receiver),
 *   https://cognidao.org/knowledge/temporal-substrate-model, .cogni/repo-spec.yaml (operator's own LEDGER_INGEST cron)
 * @public
 */

import type { GovernanceScheduleConfig } from "@cogni/scheduler-core";
import { and, eq, inArray, sql } from "drizzle-orm";
import { resolveServiceDb } from "@/bootstrap/container";
import { nodes } from "@/shared/db/nodes";
import { serverEnv } from "@/shared/env";
import {
  NODE_DEPLOY_ENVS,
  type NodeFormationEnv,
} from "@/shared/node-app-scaffold/gens";

/**
 * Statuses a node must be in to receive epoch-collect dispatch. A node is `published` (repo-spec +
 * catalog exist) well before `active`, and both should collect from their own ledgers.
 */
const ROUTABLE_NODE_STATUSES = ["published", "active"] as const;

/**
 * Hourly, on the hour — the operator polls each node's `/collect` every hour. The cron controls
 * how often the operator POKES a node; the node dedups the epoch window (`ensureEpochForWindow` is
 * idempotent), so a frequent poll is safe and just keeps each node's current epoch fresh. Hourly
 * (vs the operator's own daily cadence) keeps node epochs timely and makes the dispatch observable
 * without an out-of-band trigger. A fixed operator-side cadence needs no per-node git read.
 */
const COLLECT_DISPATCH_CRON = "0 * * * *";
const COLLECT_DISPATCH_TIMEZONE = "UTC";

/** A routable node's identity + its synthesized epoch-collect dispatch config. */
export interface RoutableNodeGovernanceConfig {
  nodeId: string;
  slug: string;
  config: GovernanceScheduleConfig;
}

interface RoutableNodeRegistryRow {
  readonly id: string;
  readonly slug: string;
  readonly deployEnvs: readonly string[];
  readonly activityEnv: string;
}

interface ResolveRoutableNodeGovernanceConfigDeps {
  readonly deployEnvironment?: string | undefined;
  readonly listRows?:
    | (() => Promise<readonly RoutableNodeRegistryRow[]>)
    | undefined;
}

function requireDeployEnvironment(value: string | undefined): NodeFormationEnv {
  if (!value || !(NODE_DEPLOY_ENVS as readonly string[]).includes(value)) {
    throw new Error(
      `epoch schedule resolution requires DEPLOY_ENVIRONMENT to be one of ${NODE_DEPLOY_ENVS.join(", ")}`
    );
  }
  return value as NodeFormationEnv;
}

/** Pure authority predicate retained after the SQL filter as a defense against stale/mocked readers. */
export function isLocalActivityAuthority(
  row: Pick<RoutableNodeRegistryRow, "deployEnvs" | "activityEnv">,
  deployEnvironment: NodeFormationEnv
): boolean {
  return (
    row.activityEnv === deployEnvironment &&
    row.deployEnvs.includes(deployEnvironment)
  );
}

/**
 * List every node eligible for epoch-collect routing — service-role (non-RLS) read of `{id, slug}`
 * for nodes in ('published','active').
 */
async function listRoutableNodes(
  deployEnvironment: NodeFormationEnv
): Promise<RoutableNodeRegistryRow[]> {
  return resolveServiceDb()
    .select({
      id: nodes.id,
      slug: nodes.slug,
      deployEnvs: nodes.deployEnvs,
      activityEnv: nodes.activityEnv,
    })
    .from(nodes)
    .where(
      and(
        inArray(nodes.status, [...ROUTABLE_NODE_STATUSES]),
        eq(nodes.activityEnv, deployEnvironment),
        sql`${deployEnvironment} = ANY(${nodes.deployEnvs})`
      )
    );
}

/**
 * Enumerate routable nodes and synthesize each one's epoch-collect dispatch schedule. NO git/App
 * read: the operator dispatches `NodeTaskWorkflow(/collect)` with `{ nodeId }`, and the node
 * self-serves its ledger config in `runCollectPass` (NODE_WRITES_OWN_LEDGER). A node with no ledger
 * or no receiver route fail-softs at dispatch time (400 / 404), so enumerating every routable node
 * is safe and needs no per-node git-authoritative read.
 */
export async function resolveRoutableNodeGovernanceConfigs(
  deps: ResolveRoutableNodeGovernanceConfigDeps = {}
): Promise<RoutableNodeGovernanceConfig[]> {
  const deployEnvironment = requireDeployEnvironment(
    deps.deployEnvironment ?? serverEnv().DEPLOY_ENVIRONMENT
  );
  const routable = deps.listRows
    ? await deps.listRows()
    : await listRoutableNodes(deployEnvironment);
  return routable
    .filter((node) => isLocalActivityAuthority(node, deployEnvironment))
    .map((node) => ({
      nodeId: node.id,
      slug: node.slug,
      config: {
        schedules: [
          {
            charter: "LEDGER_INGEST",
            cron: COLLECT_DISPATCH_CRON,
            timezone: COLLECT_DISPATCH_TIMEZONE,
            entrypoint: "LEDGER_INGEST",
          },
        ],
      },
    }));
}
