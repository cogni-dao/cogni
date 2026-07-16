// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/nodes/attribution-profile-resolver`
 * Purpose: Route an inbound GitHub webhook to the sovereign node that OWNS the repo it came from.
 *   The ONE cogni-operator GitHub App receives every repo's webhooks; each node declares its git
 *   attribution profile via `activity_ledger.activity_sources.github.source_refs` (a list of
 *   `owner/repo` full-names) in its OWN `.cogni/repo-spec.yaml`. This resolver builds a
 *   ref→nodeId index from every routable node's declared profile and answers "which node owns
 *   `owner/repo`?" so the webhook route can stamp the correct `nodeId` on ingested receipts.
 * Scope: Composition of injected deps — list routable nodes, App-read each node's repo-spec,
 *   parse → extract source-refs → `buildRepoIndex`. Behind a short-TTL single-flight cache so a
 *   burst of concurrent webhooks shares ONE rebuild. No DB/env/octokit here — all injected.
 * Invariants:
 *   - ROUTE_BY_DECLARED_SOURCE_REFS: routing keys off the repo-spec `source_refs` profile, NOT the
 *     `nodes.repo_owner/repo_name` columns (those deliberately hold the parent monorepo for
 *     deploy-via-parent detection). No schema dependency here.
 *   - PROFILE_SKIP_NEVER_THROWS: a node with a missing catalog (pre-publish fork), null/absent
 *     repo-spec, or an unparseable spec is SKIPPED (logged), never fatal — one bad node must not
 *     blank routing for the whole fleet. Total failure → empty index → caller falls back to operator.
 *   - FIRST_WRITER_WINS: delegated to `buildRepoIndex`; a repo attributes to exactly one node.
 * Side-effects: none directly (injected deps do the I/O)
 * Links: packages/repo-spec/src/repo-index.ts, src/adapters/server/vcs/github-repo-write.ts
 *   (resolveNodeRepo + fetchFileText), src/shared/cache/ttl-single-flight.ts,
 *   src/app/api/internal/webhooks/[source]/route.ts (consumer)
 * @internal
 */

import {
  buildRepoIndex,
  extractLedgerConfig,
  parseRepoSpec,
  type RepoIndexEntry,
} from "@cogni/repo-spec";
import type { Logger } from "pino";

import { ttlSingleFlight } from "@/shared/cache/ttl-single-flight";
import { makeLogger } from "@/shared/observability";

/** Default index freshness — a repo-spec profile edit takes effect within ~1 minute. */
const DEFAULT_TTL_MS = 60_000;

/** A routable node — anything the operator will index a git-attribution profile for. */
export interface RoutableNode {
  readonly id: string;
  readonly slug: string;
}

/** The node's REAL repo, as resolved from its catalog entry. */
export interface ResolvedNodeRepo {
  readonly owner: string;
  readonly repo: string;
}

export interface AttributionProfileResolverDeps {
  /** Nodes eligible for routing (status ∈ {published, active}). */
  readonly listRoutableNodes: () => Promise<readonly RoutableNode[]>;
  /** App-read `infra/catalog/<slug>.yaml` → the node's REAL `{owner, repo}`. */
  readonly resolveNodeRepo: (slug: string) => Promise<ResolvedNodeRepo>;
  /**
   * App-read the node's `.cogni/repo-spec.yaml`. `isInRepo` selects the path discriminator
   * (in-repo node → `nodes/<slug>/.cogni/repo-spec.yaml`; fork → `.cogni/repo-spec.yaml`).
   * `slug` is passed so the in-repo path can be constructed. Returns null when absent.
   */
  readonly fetchRepoSpecText: (input: {
    owner: string;
    repo: string;
    isInRepo: boolean;
    slug: string;
  }) => Promise<string | null>;
  /** The deployment parent monorepo — used to discriminate in-repo nodes from forks. */
  readonly parentOwner: string;
  readonly parentRepo: string;
  /** Injectable clock for deterministic cache tests. */
  readonly now?: () => number;
  /** Cache TTL override (ms). */
  readonly ttlMs?: number;
  readonly log?: Logger;
}

export interface RepoIndexSnapshot {
  readonly repoToNode: ReadonlyMap<string, string>;
  readonly builtAt: number;
}

export interface AttributionProfileResolver {
  /** Resolve the owning nodeId for a `owner/repo` full-name, or null if unclaimed. */
  resolveNodeForRepo(fullName: string): Promise<string | null>;
  /** The current (cached) ref→node index snapshot. */
  resolveRepoIndex(): Promise<RepoIndexSnapshot>;
}

export function createAttributionProfileResolver(
  deps: AttributionProfileResolverDeps
): AttributionProfileResolver {
  const log = deps.log ?? makeLogger({ component: "attribution-profile" });
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;

  const buildSnapshot = async (): Promise<RepoIndexSnapshot> => {
    let nodes: readonly RoutableNode[];
    try {
      nodes = await deps.listRoutableNodes();
    } catch (err) {
      // Total failure → empty index → caller falls back to the operator node.
      log.warn(
        { event: "attribution.index_build_failed", err: String(err) },
        "attribution profile index build failed — routing all to fallback"
      );
      return { repoToNode: new Map(), builtAt: now() };
    }

    // Fetch every node's profile in parallel; one bad node never blocks the others.
    const settled = await Promise.allSettled(
      nodes.map((node) => resolveNodeEntry(node, deps, log))
    );

    const entries: RepoIndexEntry[] = [];
    for (const outcome of settled) {
      if (outcome.status === "fulfilled" && outcome.value !== null) {
        entries.push(outcome.value);
      }
      // Rejections are impossible — resolveNodeEntry swallows all errors — but if one slips
      // through, it is simply omitted (fail-open to fallback), never thrown.
    }

    const { repoToNode, collisions } = buildRepoIndex(entries);
    for (const c of collisions) {
      log.warn(
        {
          event: "attribution.profile_collision",
          ref: c.ref,
          ownerNodeId: c.ownerNodeId,
          droppedNodeId: c.droppedNodeId,
        },
        "attribution source_ref claimed by multiple nodes — first-writer kept"
      );
    }

    return { repoToNode, builtAt: now() };
  };

  const cache = ttlSingleFlight<RepoIndexSnapshot>({
    compute: buildSnapshot,
    ttlMs,
    now,
  });

  return {
    async resolveRepoIndex(): Promise<RepoIndexSnapshot> {
      return cache.get();
    },
    async resolveNodeForRepo(fullName: string): Promise<string | null> {
      const key = fullName.trim().toLowerCase();
      if (key === "") return null;
      const { repoToNode } = await cache.get();
      return repoToNode.get(key) ?? null;
    },
  };
}

/**
 * Resolve ONE node's `{nodeId, sourceRefs}` entry, or null if it declares no git source-refs.
 * Swallows every failure (catalog_missing for pre-publish forks, null spec, parse error) with a
 * `attribution.profile_skipped` warn — PROFILE_SKIP_NEVER_THROWS.
 */
async function resolveNodeEntry(
  node: RoutableNode,
  deps: AttributionProfileResolverDeps,
  log: Logger
): Promise<RepoIndexEntry | null> {
  try {
    const repo = await deps.resolveNodeRepo(node.slug);
    // In-repo node ⇔ its resolved repo IS the deployment parent monorepo.
    const isInRepo =
      repo.owner.toLowerCase() === deps.parentOwner.toLowerCase() &&
      repo.repo.toLowerCase() === deps.parentRepo.toLowerCase();

    const specText = await deps.fetchRepoSpecText({
      owner: repo.owner,
      repo: repo.repo,
      isInRepo,
      slug: node.slug,
    });
    if (specText === null) {
      log.warn(
        {
          event: "attribution.profile_skipped",
          slug: node.slug,
          reason: "repo_spec_missing",
        },
        "attribution profile skipped — repo-spec not found"
      );
      return null;
    }

    const spec = parseRepoSpec(specText);
    const ledger = extractLedgerConfig(spec);
    const sourceRefs = ledger?.activitySources.github?.sourceRefs ?? [];
    if (sourceRefs.length === 0) {
      // Not an error — the node simply declares no GitHub source-refs to route.
      return null;
    }
    return { nodeId: node.id, sourceRefs };
  } catch (err) {
    const reason = (err as { code?: string })?.code ?? "profile_resolve_error";
    log.warn(
      {
        event: "attribution.profile_skipped",
        slug: node.slug,
        reason,
      },
      "attribution profile skipped"
    );
    return null;
  }
}
