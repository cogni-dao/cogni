// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/jobs/reconcileCatalogNodeRegistry.job`
 * Purpose: Reconcile deployed git catalog intent into this environment's node registry and OpenFGA store.
 * Scope: Acquires a single-writer lock, reads the exact deployed parent revision (App, or anonymous for a public
 *   catalog repo the App is not installed on — bug.5596), delegates DB projection,
 *   then ensures node-admin ownership relations. Does not schedule epochs or deliver webhooks.
 * Invariants:
 *   - APP_READS_DEPLOYED_GIT: runtime disk contents are never treated as registry intent; candidate
 *     and production project the exact source revision their running image reports.
 *   - ENV_LOCAL_PROJECTION: each environment writes only its own Postgres and OpenFGA stores.
 *   - OWNER_PROJECTION_REQUIRED: missing/unavailable authorization fails the reconcile loudly.
 *   - SINGLE_WRITER: a reserved PostgreSQL connection holds the advisory lock for the whole run.
 * Side-effects: IO (GitHub App reads, PostgreSQL writes, OpenFGA writes).
 * Links: infra/catalog/_schema.json, src/bootstrap/catalog-registry-reconcile.ts
 * @public
 */

import type { AuthorizationPort } from "@cogni/authorization-core";

import { DrizzleCatalogNodeRegistryAdapter } from "@/adapters/server";
import { getServiceDb } from "@/adapters/server/db/drizzle.service-client";
import { createCatalogNodeLister } from "@/bootstrap/capabilities/operator-deploy-plane";
import { getContainer } from "@/bootstrap/container";
import type { CatalogNodeOwnerProjection } from "@/ports";
import { serverEnv } from "@/shared/env/server-env";
import { resolveNodeCatalogSource } from "@/shared/node-registry/catalog-source";

export interface CatalogNodeRegistryJobSummary {
  readonly projected: number;
  readonly ownersWritten: number;
  readonly skipped: boolean;
}

export async function runCatalogNodeRegistryReconcileJob(): Promise<CatalogNodeRegistryJobSummary> {
  const env = serverEnv();
  const container = getContainer();
  const { log, authorization } = container;
  // Same source as the identity broker: the repo whose catalog defines this env's
  // nodes, which on candidate-a/preview is NOT the submodule pin-PR target (bug.5073).
  const source = resolveNodeCatalogSource(env);
  const sourceRef = env.APP_BUILD_SHA ?? "main";

  if (!source) {
    throw new Error(
      "catalog registry reconcile requires NODE_REGISTRY_CATALOG_* or NODE_SUBMODULE_PARENT_*"
    );
  }
  const parentOwner = source.owner;
  const parentRepo = source.repo;
  if (!authorization) {
    throw new Error(
      "catalog registry reconcile requires an environment-local OpenFGA authorization adapter"
    );
  }

  const serviceDb = getServiceDb();
  const reservedConn = await serviceDb.$client.reserve();
  const [lockRow] =
    await reservedConn`SELECT pg_try_advisory_lock(hashtext('catalog_node_registry_reconcile')) AS acquired`;
  const acquired = (lockRow as { acquired: boolean } | undefined)?.acquired;
  if (!acquired) {
    reservedConn.release();
    log.info({}, "Catalog node registry reconcile already running, skipping");
    return { projected: 0, ownersWritten: 0, skipped: true };
  }

  try {
    log.info(
      {
        parentOwner,
        parentRepo,
        sourceRef,
        deployEnvironment: env.DEPLOY_ENVIRONMENT,
      },
      "Starting catalog node registry reconcile"
    );
    const definitions = await createCatalogNodeLister(env).listCatalogNodes({
      parentOwner,
      parentRepo,
      sourceRef,
    });
    const registry = new DrizzleCatalogNodeRegistryAdapter(serviceDb);
    const projection = await registry.reconcile(definitions);

    const ownersWritten = await ensureCatalogNodeOwnerRelations(
      authorization,
      projection.owners
    );

    const summary = {
      projected: projection.projected,
      ownersWritten,
      skipped: false,
    } as const;
    log.info(summary, "Catalog node registry reconcile complete");
    return summary;
  } catch (error) {
    log.error(
      { error, err: String(error), sourceRef },
      "Catalog node registry reconcile failed"
    );
    throw error;
  } finally {
    await reservedConn`SELECT pg_advisory_unlock(hashtext('catalog_node_registry_reconcile'))`;
    reservedConn.release();
  }
}

/** Ensure the env-local owner receives the node model's concrete ownership role. */
export async function ensureCatalogNodeOwnerRelations(
  authorization: AuthorizationPort,
  owners: readonly CatalogNodeOwnerProjection[]
): Promise<number> {
  for (const owner of owners) {
    const result = await authorization.writeRelation({
      user: `user:${owner.ownerUserId}`,
      // The OpenFGA node model names its ownership/admin role `admin`;
      // every node capability (developer/secrets/promote/envs) inherits it.
      relation: "admin",
      object: `node:${owner.nodeId}`,
    });
    if (result.decision !== "success") {
      throw new Error(
        `failed to project owner relation for node ${owner.nodeId}: ${result.reason ?? result.code}`
      );
    }
  }
  return owners.length;
}
