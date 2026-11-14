// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/nodes/attribution-profile-resolver`
 * Purpose: Route an inbound GitHub webhook to the one sovereign node whose merged catalog entry
 *   and own repo-spec jointly declare the webhook repository as an attribution source.
 * Scope: Composes injected catalog/spec reads, validates node identity, builds a short-lived routing
 *   snapshot, and returns a typed routing decision. No DB/env/Octokit access is embedded here.
 * Invariants:
 *   - CATALOG_AND_PROFILE_JOINT_AUTHORITY: the merged parent catalog selects locally authoritative
 *     nodes; each selected node's own repo-spec selects its source repositories.
 *   - UNIQUE_ROUTE_OR_NO_WRITE: unknown, ambiguous, mismatched, and unreadable profiles never route
 *     to a fallback ledger.
 *   - NODE_IDENTITY_MATCHES: a catalog node_id projection must equal the child repo-spec node_id.
 *   - SHORT_LIVED_SINGLE_FLIGHT: a bounded cache prevents GitHub API fan-out per webhook while a
 *     newly merged spawn becomes discoverable without redeploying the operator.
 * Side-effects: none directly (injected dependencies perform GitHub App reads and logging).
 * Links: packages/repo-spec/src/repo-index.ts, https://node-template.cognidao.org/knowledge/attribution-operator-gateway
 *   src/app/api/internal/webhooks/[source]/route.ts, bug.5052
 * @internal
 */

import {
  buildRepoIndex,
  extractLedgerConfig,
  extractNodeId,
  parseRepoSpec,
  type RepoIndexEntry,
} from "@cogni/repo-spec";
import type { Logger } from "pino";

import { ttlSingleFlight } from "@/shared/cache/ttl-single-flight";
import { makeLogger } from "@/shared/observability";

/** Catalog/spec edits become visible quickly without rebuilding the index for every webhook. */
const DEFAULT_TTL_MS = 10_000;

/** Minimal registry identity retained for sibling config resolvers. */
export interface RoutableNode {
  readonly id: string;
  readonly slug: string;
}

export interface AttributionRoutingNode extends RoutableNode {
  readonly repo: ResolvedNodeRepo;
}

/** Minimal merged-catalog projection needed to select this environment's activity authority. */
export interface CatalogAttributionNode {
  readonly nodeId: string;
  readonly slug: string;
  readonly repoOwner: string;
  readonly repoName: string;
  readonly deployEnvs: readonly string[];
  readonly activityEnv: string;
}

export interface ResolvedNodeRepo {
  readonly owner: string;
  readonly repo: string;
}

export type RepoRouteIssueReason =
  | "repo_spec_missing"
  | "repo_spec_read_failed"
  | "repo_spec_invalid"
  | "node_id_mismatch"
  | "catalog_repo_undeclared";

export interface RepoRouteIssue {
  readonly nodeId: string;
  readonly slug: string;
  readonly reason: RepoRouteIssueReason;
}

export type RepoRouteDecision =
  | {
      readonly status: "matched";
      readonly repo: string;
      readonly target: AttributionRoutingNode;
    }
  | {
      readonly status: "unclaimed";
      readonly repo: string;
    }
  | {
      readonly status: "ambiguous";
      readonly repo: string;
      readonly nodeIds: readonly string[];
    }
  | {
      readonly status: "profile_unavailable";
      readonly repo: string;
      readonly issue: RepoRouteIssue;
    }
  | {
      readonly status: "index_unavailable";
      readonly repo: string;
    };

export interface AttributionProfileResolverDeps {
  /** App-read merged catalog entries already selected for local activity authority. */
  readonly listRoutingNodes: () => Promise<readonly AttributionRoutingNode[]>;
  /** App-read the node's own `.cogni/repo-spec.yaml` from main. */
  readonly fetchRepoSpecText: (input: {
    owner: string;
    repo: string;
    isInRepo: boolean;
    slug: string;
  }) => Promise<string | null>;
  readonly parentOwner: string;
  readonly parentRepo: string;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly log?: Logger;
}

export interface RepoIndexSnapshot {
  readonly repoToTarget: ReadonlyMap<string, AttributionRoutingNode>;
  readonly ambiguousRepos: ReadonlyMap<string, readonly string[]>;
  readonly catalogRepoIssues: ReadonlyMap<string, RepoRouteIssue>;
  readonly builtAt: number;
}

export interface AttributionProfileResolver {
  /** Resolve one normalized repository to a typed, fail-closed routing decision. */
  resolveRepoRoute(
    fullName: string,
    options?: { readonly forceRefresh?: boolean }
  ): Promise<RepoRouteDecision>;
  /** Return the current discovery snapshot for deterministic readiness diagnostics. */
  resolveRepoIndex(): Promise<RepoIndexSnapshot>;
}

/** Select only nodes whose catalog says this environment owns activity and deploys the node. */
export function selectLocalAttributionNodes(
  definitions: readonly CatalogAttributionNode[],
  deployEnvironment: string
): AttributionRoutingNode[] {
  return definitions
    .filter(
      (node) =>
        node.activityEnv === deployEnvironment &&
        node.deployEnvs.includes(deployEnvironment)
    )
    .map((node) => ({
      id: node.nodeId,
      slug: node.slug,
      repo: { owner: node.repoOwner, repo: node.repoName },
    }));
}

export function createAttributionProfileResolver(
  deps: AttributionProfileResolverDeps
): AttributionProfileResolver {
  const log = deps.log ?? makeLogger({ component: "attribution-profile" });
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;

  const buildSnapshot = async (): Promise<RepoIndexSnapshot> => {
    const nodes = await deps.listRoutingNodes();
    const settled = await Promise.all(
      nodes.map((node) => resolveNodeProfile(node, deps))
    );

    const ready = settled.filter(
      (result): result is ResolvedNodeProfile => result.status === "ready"
    );
    const entries: RepoIndexEntry[] = ready.map((result) => ({
      nodeId: result.target.id,
      sourceRefs: result.sourceRefs,
    }));
    const targetByNodeId = new Map(
      ready.map((result) => [result.target.id, result.target] as const)
    );
    const { repoToNode, collisions } = buildRepoIndex(entries);

    const ambiguousRepos = new Map<string, readonly string[]>();
    for (const collision of collisions) {
      const nodeIds = new Set(
        ambiguousRepos.get(collision.ref) ?? [collision.ownerNodeId]
      );
      nodeIds.add(collision.droppedNodeId);
      ambiguousRepos.set(collision.ref, [...nodeIds].sort());
      repoToNode.delete(collision.ref);
    }

    const repoToTarget = new Map<string, AttributionRoutingNode>();
    for (const [repo, nodeId] of repoToNode) {
      const target = targetByNodeId.get(nodeId);
      if (target) repoToTarget.set(repo, target);
    }

    const catalogRepoIssues = new Map<string, RepoRouteIssue>();
    for (const result of settled) {
      if (result.status === "issue") {
        catalogRepoIssues.set(normalizeRepo(result.catalogRepo), result.issue);
        continue;
      }
      const catalogRepo = normalizeRepo(
        `${result.target.repo.owner}/${result.target.repo.repo}`
      );
      if (
        !result.sourceRefs.some((ref) => normalizeRepo(ref) === catalogRepo)
      ) {
        catalogRepoIssues.set(catalogRepo, {
          nodeId: result.target.id,
          slug: result.target.slug,
          reason: "catalog_repo_undeclared",
        });
      }
    }

    for (const [repo, nodeIds] of ambiguousRepos) {
      log.error(
        { event: "attribution.profile_ambiguous", repo, nodeIds },
        "attribution source repository is claimed by multiple nodes"
      );
    }
    for (const [repo, issue] of catalogRepoIssues) {
      log.warn(
        { event: "attribution.profile_unavailable", repo, ...issue },
        "attribution profile is not ready for routing"
      );
    }

    const snapshot = {
      repoToTarget,
      ambiguousRepos,
      catalogRepoIssues,
      builtAt: now(),
    } as const;
    log.info(
      {
        event: "attribution.profile_index_ready",
        nodeCount: nodes.length,
        routeCount: repoToTarget.size,
        ambiguousCount: ambiguousRepos.size,
        unavailableCount: catalogRepoIssues.size,
        builtAt: snapshot.builtAt,
      },
      "attribution profile index ready"
    );
    return snapshot;
  };

  const cache = ttlSingleFlight<RepoIndexSnapshot>({
    compute: buildSnapshot,
    ttlMs,
    now,
    // Ownership changes must fail closed; a stale last-good route is not safe authority.
    serveStaleOnFailure: false,
  });

  return {
    async resolveRepoIndex(): Promise<RepoIndexSnapshot> {
      return cache.get();
    },
    async resolveRepoRoute(
      fullName: string,
      options?: { readonly forceRefresh?: boolean }
    ): Promise<RepoRouteDecision> {
      const repo = normalizeRepo(fullName);
      if (repo === "") return { status: "unclaimed", repo };

      let snapshot: RepoIndexSnapshot;
      try {
        snapshot = options?.forceRefresh
          ? await cache.refresh()
          : await cache.get();
      } catch (err) {
        log.error(
          { event: "attribution.profile_index_failed", repo, err: String(err) },
          "attribution profile index unavailable"
        );
        return { status: "index_unavailable", repo };
      }

      const ambiguous = snapshot.ambiguousRepos.get(repo);
      if (ambiguous) {
        return { status: "ambiguous", repo, nodeIds: ambiguous };
      }
      const issue = snapshot.catalogRepoIssues.get(repo);
      if (issue) return { status: "profile_unavailable", repo, issue };
      const target = snapshot.repoToTarget.get(repo);
      if (target) return { status: "matched", repo, target };
      return { status: "unclaimed", repo };
    },
  };
}

interface ResolvedNodeProfile {
  readonly status: "ready";
  readonly target: AttributionRoutingNode;
  readonly sourceRefs: readonly string[];
}

interface UnavailableNodeProfile {
  readonly status: "issue";
  readonly catalogRepo: string;
  readonly issue: RepoRouteIssue;
}

async function resolveNodeProfile(
  target: AttributionRoutingNode,
  deps: AttributionProfileResolverDeps
): Promise<ResolvedNodeProfile | UnavailableNodeProfile> {
  const catalogRepo = `${target.repo.owner}/${target.repo.repo}`;
  const issue = (reason: RepoRouteIssueReason): UnavailableNodeProfile => ({
    status: "issue",
    catalogRepo,
    issue: { nodeId: target.id, slug: target.slug, reason },
  });

  const isInRepo =
    normalizeRepo(catalogRepo) ===
    normalizeRepo(`${deps.parentOwner}/${deps.parentRepo}`);

  let specText: string | null;
  try {
    specText = await deps.fetchRepoSpecText({
      owner: target.repo.owner,
      repo: target.repo.repo,
      isInRepo,
      slug: target.slug,
    });
  } catch {
    return issue("repo_spec_read_failed");
  }
  if (specText === null) return issue("repo_spec_missing");

  try {
    const spec = parseRepoSpec(specText);
    if (extractNodeId(spec) !== target.id) return issue("node_id_mismatch");
    const ledger = extractLedgerConfig(spec);
    return {
      status: "ready",
      target,
      sourceRefs: ledger?.activitySources.github?.sourceRefs ?? [],
    };
  } catch {
    return issue("repo_spec_invalid");
  }
}

function normalizeRepo(value: string): string {
  return value.trim().toLowerCase();
}
