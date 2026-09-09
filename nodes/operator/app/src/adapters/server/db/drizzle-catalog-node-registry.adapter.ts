// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/db/drizzle-catalog-node-registry`
 * Purpose: Project merged catalog nodes into one environment's PostgreSQL registry.
 * Scope: Resolves env-local users by wallet and upserts catalog-owned node fields.
 * Invariants:
 *   - PLACEMENT_IS_CATALOG_OWNED: `deployment_providers` is overwritten from the row on EVERY
 *     reconcile (bug.5106). Placement is git intent — moving a node between providers is a catalog
 *     edit that must reach the registry the address resolver reads, including back to `{}` (k3s).
 *   - OWNER_WALLET_IS_STABLE_BINDING: never imports a users.id from another environment.
 *   - NODE_ID_IS_DEPLOYMENT_IDENTITY: an existing slug with another ID fails loud.
 *   - STATUS_NEVER_REGRESSES: status is `published` only on first insert and is omitted on update.
 *   - TRANSACTIONAL_PROJECTION: all catalog rows project atomically in one environment.
 * Side-effects: IO (PostgreSQL writes through the injected service-role database).
 * Links: src/ports/catalog-node-registry.port.ts, src/shared/db/nodes.ts
 * @public
 */

import { randomUUID } from "node:crypto";

import type { Database } from "@cogni/db-client";
import { eq, sql } from "drizzle-orm";

import type {
  CatalogNodeDefinition,
  CatalogNodeOwnerProjection,
  CatalogNodeRegistryPort,
  CatalogNodeRegistryReconcileSummary,
} from "@/ports";
import { nodes, users } from "@/shared/db/schema";

export class DrizzleCatalogNodeRegistryAdapter
  implements CatalogNodeRegistryPort
{
  constructor(private readonly db: Database) {}

  async reconcile(
    definitions: readonly CatalogNodeDefinition[]
  ): Promise<CatalogNodeRegistryReconcileSummary> {
    const owners = await this.db.transaction(async (tx) => {
      const projected: CatalogNodeOwnerProjection[] = [];

      for (const definition of definitions) {
        const ownerUserId = await resolveOrCreateOwnerUserId(
          tx,
          definition.ownerWallet
        );
        const [node] = await tx
          .insert(nodes)
          .values({
            id: definition.nodeId,
            slug: definition.slug,
            repoUrl: definition.repoUrl,
            repoOwner: definition.repoOwner,
            repoName: definition.repoName,
            repoVisibility: "public",
            ownerUserId,
            deployEnvs: [...definition.deployEnvs],
            activityEnv: definition.activityEnv,
            deploymentProviders: { ...definition.deploymentProviders },
            status: "published",
          })
          .onConflictDoUpdate({
            target: nodes.slug,
            set: {
              repoUrl: definition.repoUrl,
              repoOwner: definition.repoOwner,
              repoName: definition.repoName,
              repoVisibility: "public",
              ownerUserId,
              deployEnvs: [...definition.deployEnvs],
              activityEnv: definition.activityEnv,
              deploymentProviders: { ...definition.deploymentProviders },
              updatedAt: new Date(),
            },
          })
          .returning({ id: nodes.id });

        if (!node || node.id !== definition.nodeId) {
          throw new Error(
            `catalog node identity mismatch for '${definition.slug}': expected ${definition.nodeId}, found ${node?.id ?? "no row"}`
          );
        }
        projected.push({ nodeId: node.id, ownerUserId });
      }

      return projected;
    });

    return { projected: definitions.length, owners };
  }
}

type CatalogRegistryTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

async function resolveOrCreateOwnerUserId(
  tx: CatalogRegistryTransaction,
  ownerWallet: string
): Promise<string> {
  const [existing] = await tx
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.walletAddress}) = lower(${ownerWallet})`)
    .limit(1);
  if (existing) return existing.id;

  const userId = randomUUID();
  const [created] = await tx
    .insert(users)
    .values({ id: userId, walletAddress: ownerWallet })
    .onConflictDoNothing({ target: users.walletAddress })
    .returning({ id: users.id });
  if (created) return created.id;

  const [raced] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.walletAddress, ownerWallet))
    .limit(1);
  if (!raced) {
    throw new Error(
      `failed to resolve local user for owner wallet ${ownerWallet}`
    );
  }
  return raced.id;
}
