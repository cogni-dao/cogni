// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/jobs/syncNodeAdmins.job`
 * Purpose: One node-admin sync tick: lock, load node rows from `nodes`, sync each node's admins.
 * Scope: Wiring only. Reads node rows from the service DB (never the catalog), builds the App-only approver
 *   reader, and delegates per-node work to `nodeAdminSync.ts`. Does not schedule itself.
 * Invariants:
 *   - OWN_LOCK: a reserved PostgreSQL connection holds `pg_try_advisory_lock(hashtext('node_admin_sync'))`,
 *     a different lock from the catalog reconcile, so the two never block each other.
 *   - NODES_NOT_CATALOG: node rows come from `nodes`; this job never reads the catalog (bug.5164).
 *   - LISTED_NODES_ONLY: only rows with a projected `repo_spec_path` are synced. A wizard-born row the
 *     catalog does not list yet has no admin answer here; its spawner stays its only admin.
 *   - APP_ONLY_READ: repo-spec reads go through `createOperatorDeployPlane` (GitHub App contents API).
 *     Never `AppOrPublicDeclarationReader`, never raw.githubusercontent.
 * Side-effects: IO (PostgreSQL reads, GitHub App reads, OpenFGA reads and, in write mode, writes).
 * Links: src/bootstrap/jobs/nodeAdminSync.ts, src/bootstrap/node-admin-sync.ts, task.5494
 * @public
 */

import { isNotNull } from "drizzle-orm";

import {
  drizzleUsersForWallets,
  extractRepoSpecApprovers,
  NodeApproverReadError,
  RepoSpecNodeApproverReader,
} from "@/adapters/server";
import { getServiceDb } from "@/adapters/server/db/drizzle.service-client";
import { createOperatorDeployPlane } from "@/bootstrap/capabilities/operator-deploy-plane";
import { getContainer } from "@/bootstrap/container";
import {
  type NodeAdminSyncResult,
  syncNodeAdmins,
} from "@/bootstrap/jobs/nodeAdminSync";
import type { DeployPlanePort } from "@/ports";
import { nodes } from "@/shared/db/nodes";
import { serverEnv } from "@/shared/env/server-env";
import { nodeAdminSyncLastSuccessSeconds } from "@/shared/observability/server";

export interface NodeAdminSyncJobSummary {
  readonly nodes: number;
  readonly byOutcome: Readonly<Record<string, number>>;
  readonly mode: "report" | "write";
  readonly skipped: boolean;
}

let appReader: Pick<DeployPlanePort, "fetchFileText"> | undefined;

export async function runNodeAdminSyncJob(): Promise<NodeAdminSyncJobSummary> {
  const env = serverEnv();
  const { log, authorization } = getContainer();
  const mode = env.NODE_ADMIN_SYNC_WRITE ? "write" : "report";

  if (!authorization) {
    log.warn({ mode }, "Node admin sync skipped: no OpenFGA authorization");
    return { nodes: 0, byOutcome: {}, mode, skipped: true };
  }

  const serviceDb = getServiceDb();
  const reservedConn = await serviceDb.$client.reserve();
  const [lockRow] =
    await reservedConn`SELECT pg_try_advisory_lock(hashtext('node_admin_sync')) AS acquired`;
  const acquired = (lockRow as { acquired: boolean } | undefined)?.acquired;
  if (!acquired) {
    reservedConn.release();
    log.info({}, "Node admin sync already running, skipping");
    return { nodes: 0, byOutcome: {}, mode, skipped: true };
  }

  try {
    const rows = await serviceDb
      .select({
        nodeId: nodes.id,
        repoOwner: nodes.repoOwner,
        repoName: nodes.repoName,
        repoSpecPath: nodes.repoSpecPath,
      })
      .from(nodes)
      .where(isNotNull(nodes.repoSpecPath));

    const targets = rows.flatMap((row) =>
      row.repoSpecPath
        ? [
            {
              nodeId: row.nodeId,
              repoUrl: `https://github.com/${row.repoOwner}/${row.repoName}`,
              repoSpecPath: row.repoSpecPath,
            },
          ]
        : []
    );

    const reader = new RepoSpecNodeApproverReader({
      fetchRepoSpec: (ref, path) => {
        const { owner, repo } = parseGithubRepoUrl(ref);
        if (!appReader) {
          try {
            appReader = createOperatorDeployPlane(env);
          } catch {
            // No GH_REVIEW_APP_* configured: there is no App to read through.
            throw new NodeApproverReadError(
              "no_app_installation",
              "operator GitHub App is not configured"
            );
          }
        }
        return appReader.fetchFileText({ owner, repo, path });
      },
      extractApprovers: extractRepoSpecApprovers,
      usersForWallets: drizzleUsersForWallets(serviceDb),
    });

    const results = await syncNodeAdmins(
      { reader, authorization, write: env.NODE_ADMIN_SYNC_WRITE, log },
      targets
    );

    const byOutcome = countByOutcome(results);
    // Liveness means the sync did real work: at least one node reached `ok`. A tick where every
    // node is unavailable must not look healthy.
    if ((byOutcome.ok ?? 0) > 0) {
      nodeAdminSyncLastSuccessSeconds.set(Date.now() / 1000);
    }
    return { nodes: results.length, byOutcome, mode, skipped: false };
  } finally {
    await reservedConn`SELECT pg_advisory_unlock(hashtext('node_admin_sync'))`;
    reservedConn.release();
  }
}

function countByOutcome(
  results: readonly NodeAdminSyncResult[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const result of results) {
    counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;
  }
  return counts;
}

/** `https://github.com/<owner>/<repo>` to its parts. Throws on any other shape (read becomes `unavailable`). */
export function parseGithubRepoUrl(url: string): {
  owner: string;
  repo: string;
} {
  const [owner, repo, ...extra] = new URL(url).pathname
    .split("/")
    .filter(Boolean);
  if (!owner || !repo || extra.length > 0) {
    throw new Error(`not a GitHub repo URL: ${url}`);
  }
  return { owner, repo: repo.replace(/\.git$/, "") };
}
